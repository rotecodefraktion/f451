import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { checkStylesheet, rewriteFontUrls } from '@f451/design-tokens'
import type { GitFile } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { SpaceConfig } from '../spaces/config.js'
import { invalidateInstanceTheme } from '../theme/instance-theme.js'
import { invalidateSpaceTheme } from '../theme/space-theme.js'
import {
  loadFont,
  loadStylesheet,
  STYLESHEET_MAX_BYTES,
  STYLESHEET_PATH,
  type StylesheetScope,
} from '../theme/stylesheet.js'
import { resolveNewPageWriteContext, type NewPageGateDeps } from './drafts.js'
import {
  forbiddenSchema,
  instanceWriteTarget,
  providerFailure,
  themeWriteGateDeps,
  type ThemeDeps,
  type WriteTarget,
} from './theme.js'

/**
 * Theme stylesheet routes (f451#61), modelled on `brand.ts`:
 *
 *  - `GET /api/theme/stylesheet`, `GET /api/spaces/:space/theme/stylesheet` — the
 *    checked `_meta/theme.css` of the instance resp. the space, with every
 *    `url(fonts/<name>.woff2)` pointed at the font route of the same scope. A space
 *    without its own valid file answers 404 — no fallback, the layout links the
 *    instance file separately.
 *  - `GET /api/theme/fonts/:name`, `GET /api/spaces/:space/theme/fonts/:name` — one
 *    WOFF2 font of `_meta/fonts/`.
 *  - `PUT` / `DELETE /api/theme/stylesheet` and `/api/spaces/:space/theme/stylesheet` —
 *    write or remove `_meta/theme.css` with the caller's own provider token and the
 *    theme write gates. The PUT body is the raw CSS (like the brand upload takes the
 *    raw SVG), checked before anything is committed.
 *
 * The GETs are public like `/api/brand/*` (GET-only exemption in `app.ts`); the space
 * routes check read access themselves. ETag is the blob sha.
 */

const INSTANCE_STYLESHEET_URL = '/api/theme/stylesheet'
const INSTANCE_FONTS_BASE = '/api/theme/fonts/'

const spaceStylesheetUrl = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/theme/stylesheet`
const spaceFontsBase = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/theme/fonts/`

/** Request bodies up to this size reach the handler and get the 422 `css_too_large`;
 *  beyond it Fastify answers 413 itself. */
const UPLOAD_BODY_LIMIT = 4 * STYLESHEET_MAX_BYTES

/** The stylesheet lives on the published state, like the theme. */
const STYLESHEET_BRANCH = 'main'

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const spaceParams = {
  type: 'object',
  properties: { space: { type: 'string' } },
  required: ['space'],
} as const

const fontParams = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const

const spaceFontParams = {
  type: 'object',
  properties: { space: { type: 'string' }, name: { type: 'string' } },
  required: ['space', 'name'],
} as const

/** 422 of an upload: the rule violations with their line, or `css_too_large` / `css_not_text`. */
const cssInvalidSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['invalid'] },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          line: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
      },
    },
  },
  required: ['status', 'errors'],
} as const

const getSchema = { tags: ['theme'], response: { 404: errorSchema } } as const
const getSpaceSchema = { tags: ['theme'], params: spaceParams, response: { 404: errorSchema } } as const
const getFontSchema = { tags: ['theme'], params: fontParams, response: { 404: errorSchema } } as const
const getSpaceFontSchema = { tags: ['theme'], params: spaceFontParams, response: { 404: errorSchema } } as const

const writeErrors = {
  403: forbiddenSchema,
  404: errorSchema,
  409: errorSchema,
  422: cssInvalidSchema,
  502: errorSchema,
} as const

const putResponse = {
  type: 'object',
  properties: { url: { type: 'string' } },
  required: ['url'],
} as const

const putSchema = { tags: ['theme'], response: { 200: putResponse, ...writeErrors } } as const
const putSpaceSchema = { tags: ['theme'], params: spaceParams, response: { 200: putResponse, ...writeErrors } } as const
const deleteResponses = {
  204: { type: 'null', description: 'The stylesheet was removed.' },
  ...writeErrors,
} as const
const deleteSchema = { tags: ['theme'], response: deleteResponses } as const
const deleteSpaceSchema = { tags: ['theme'], params: spaceParams, response: deleteResponses } as const

type CssError = { code: string; line?: number; message: string }

function invalid(errors: CssError[]) {
  return { status: 'invalid' as const, errors }
}

/** Sets ETag, Cache-Control and `nosniff`; answers 304 on a matching `If-None-Match`. */
function sendCached(
  req: Pick<FastifyRequest, 'headers'>,
  reply: FastifyReply,
  sha: string,
  cacheControl: string,
  type: string,
  body: string | Buffer,
): FastifyReply {
  const etag = `"${sha}"`
  reply.header('ETag', etag)
  reply.header('Cache-Control', cacheControl)
  reply.header('X-Content-Type-Options', 'nosniff')
  if (req.headers['if-none-match'] === etag) return reply.code(304).send()
  return reply.type(type).send(body)
}

type UploadCheck = { ok: true; content: Buffer } | { ok: false; body: ReturnType<typeof invalid> }

/** Size first, then the rules; nothing is committed when this fails. */
function checkUpload(body: unknown): UploadCheck {
  const bytes = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : null
  if (!bytes || bytes.length === 0) {
    return {
      ok: false,
      body: invalid([{ code: 'css_not_text', message: 'the body must be a non-empty CSS file (text/css)' }]),
    }
  }
  if (bytes.length > STYLESHEET_MAX_BYTES) {
    return { ok: false, body: invalid([{ code: 'css_too_large', message: 'a theme stylesheet may be at most 256 KB' }]) }
  }
  const check = checkStylesheet(bytes.toString('utf8'))
  if (!check.ok) return { ok: false, body: invalid(check.problems) }
  return { ok: true, content: bytes }
}

async function readOptional(target: WriteTarget, path: string): Promise<GitFile | null> {
  try {
    return await target.provider.readFile(target.space.repoRef, path, STYLESHEET_BRANCH)
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/** Commits `_meta/theme.css`; `null` on success. */
async function writeStylesheet(target: WriteTarget, content: Buffer, reply: FastifyReply): Promise<FastifyReply | null> {
  let current: GitFile | null
  try {
    current = await readOptional(target, STYLESHEET_PATH)
  } catch (err) {
    return providerFailure(reply, err)
  }
  try {
    await target.provider.commitFiles(
      target.space.repoRef,
      [{ op: 'write', path: STYLESHEET_PATH, content, sha: current?.sha }],
      { branch: STYLESHEET_BRANCH, message: 'Theme: stylesheet' },
    )
  } catch (err) {
    return providerFailure(reply, err)
  }
  return null
}

/** Removes `_meta/theme.css`; 404 when there is none, `null` on success. */
async function removeStylesheet(target: WriteTarget, reply: FastifyReply): Promise<FastifyReply | null> {
  const none = () => reply.code(404).send({ status: 'not_found', reason: 'There is no stylesheet to remove.' })
  let current: GitFile | null
  try {
    current = await readOptional(target, STYLESHEET_PATH)
  } catch (err) {
    return providerFailure(reply, err)
  }
  if (!current) return none()
  try {
    await target.provider.commitFiles(
      target.space.repoRef,
      [{ op: 'delete', path: STYLESHEET_PATH, sha: current.sha }],
      { branch: STYLESHEET_BRANCH, message: 'Theme: remove stylesheet' },
    )
  } catch (err) {
    return err instanceof NotFoundError ? none() : providerFailure(reply, err)
  }
  return null
}

function registerStylesheetWriteRoutes(instance: FastifyInstance, gateDeps: NewPageGateDeps, deps: ThemeDeps): void {
  async function upload(body: unknown, reply: FastifyReply, target: WriteTarget, url: string, invalidate: () => void) {
    const checked = checkUpload(body)
    if (!checked.ok) return reply.code(422).send(checked.body)
    const failed = await writeStylesheet(target, checked.content, reply)
    if (failed) return failed
    invalidate()
    return reply.code(200).send({ url })
  }

  instance.put('/api/theme/stylesheet', { schema: putSchema, bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
    if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
    return upload(req.body, reply, target, INSTANCE_STYLESHEET_URL, invalidateInstanceTheme)
  })

  instance.delete('/api/theme/stylesheet', { schema: deleteSchema }, async (req, reply) => {
    const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
    if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
    const failed = await removeStylesheet(target, reply)
    if (failed) return failed
    invalidateInstanceTheme()
    return reply.code(204).send()
  })

  instance.put<{ Params: { space: string } }>(
    '/api/spaces/:space/theme/stylesheet',
    { schema: putSpaceSchema, bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      // Unknown/unreadable space → 404, no linked account / no push right → 403.
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const spaceId = target.space.id
      return upload(req.body, reply, target, spaceStylesheetUrl(spaceId), () => invalidateSpaceTheme(spaceId))
    },
  )

  instance.delete<{ Params: { space: string } }>(
    '/api/spaces/:space/theme/stylesheet',
    { schema: deleteSpaceSchema },
    async (req, reply) => {
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const failed = await removeStylesheet(target, reply)
      if (failed) return failed
      invalidateSpaceTheme(target.space.id)
      return reply.code(204).send()
    },
  )
}

export function registerThemeStylesheetRoutes(app: FastifyInstance, deps: ThemeDeps): void {
  /** Same check as `theme.ts#readableSpace`; anonymous callers pass `''`. */
  async function readableSpace(spaceId: string, userId: string): Promise<SpaceConfig | null> {
    const space = deps.spaces?.find((s) => s.id === spaceId)
    if (!space) return null
    if (deps.access && !(await deps.access.canRead(userId, space))) return null
    return space
  }

  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ status: 'not_found', reason: `There is no ${what}.` })

  async function serveStylesheet(
    req: Pick<FastifyRequest, 'headers' | 'log'>,
    reply: FastifyReply,
    scope: StylesheetScope,
    fontsBase: string,
    cacheControl: string,
  ) {
    const file = await loadStylesheet(deps, scope, req.log)
    if (!file) return notFound(reply, 'stylesheet')
    return sendCached(req, reply, file.sha, cacheControl, 'text/css; charset=utf-8', rewriteFontUrls(file.css, fontsBase))
  }

  async function serveFont(
    req: Pick<FastifyRequest, 'headers' | 'log'>,
    reply: FastifyReply,
    scope: StylesheetScope,
    name: string,
    cacheControl: string,
  ) {
    const font = await loadFont(deps, scope, name, req.log)
    if (!font) return notFound(reply, 'font')
    return sendCached(req, reply, font.sha, cacheControl, 'font/woff2', font.content)
  }

  app.register(async (instance) => {
    // Uploads are raw bytes of any declared type (pattern `brand.ts`): CSS sent as
    // text/css or with another type must reach the handler and its 422, not Fastify's 415.
    instance.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (_req, body, done) => {
      done(null, body)
    })

    instance.get('/api/theme/stylesheet', { schema: getSchema }, async (req, reply) =>
      serveStylesheet(req, reply, { kind: 'instance' }, INSTANCE_FONTS_BASE, 'public, max-age=300'),
    )

    instance.get<{ Params: { name: string } }>('/api/theme/fonts/:name', { schema: getFontSchema }, async (req, reply) =>
      serveFont(req, reply, { kind: 'instance' }, req.params.name, 'public, max-age=86400'),
    )

    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/theme/stylesheet',
      { schema: getSpaceSchema },
      async (req, reply) => {
        const space = await readableSpace(req.params.space, req.user?.id ?? '')
        if (!space) return notFound(reply, 'stylesheet')
        // `private`: the answer depends on the caller's read access to the space.
        return serveStylesheet(req, reply, { kind: 'space', space }, spaceFontsBase(space.id), 'private, max-age=300')
      },
    )

    instance.get<{ Params: { space: string; name: string } }>(
      '/api/spaces/:space/theme/fonts/:name',
      { schema: getSpaceFontSchema },
      async (req, reply) => {
        const space = await readableSpace(req.params.space, req.user?.id ?? '')
        if (!space) return notFound(reply, 'font')
        return serveFont(req, reply, { kind: 'space', space }, req.params.name, 'private, max-age=86400')
      },
    )

    const gateDeps = themeWriteGateDeps(deps)
    if (gateDeps) registerStylesheetWriteRoutes(instance, gateDeps, deps)
  })
}
