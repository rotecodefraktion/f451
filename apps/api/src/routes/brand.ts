import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { parseThemeFile } from '@f451/design-tokens'
import type { FileChange, GitFile } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { isMap, parseDocument } from 'yaml'
import type { SpaceConfig } from '../spaces/config.js'
import { InvalidSvgError } from '../drafts/svg-sanitize.js'
import {
  BRAND_FILE_PATHS,
  BRAND_MAX_BYTES,
  loadBrandFile,
  sanitizeBrandSvg,
  type BrandFile,
  type BrandKind,
} from '../theme/brand.js'
import { INSTANCE_THEME_PATH, invalidateInstanceTheme } from '../theme/instance-theme.js'
import { invalidateSpaceTheme } from '../theme/space-theme.js'
import { resolveNewPageWriteContext, type NewPageGateDeps } from './drafts.js'
import {
  forbiddenSchema,
  instanceWriteTarget,
  invalidSchema,
  providerFailure,
  themeWriteGateDeps,
  type ThemeDeps,
  type WriteTarget,
} from './theme.js'

/**
 * Brand routes (theming addendum §5):
 *
 *  - `GET /api/brand/logo`, `GET /api/brand/favicon` — the instance files.
 *  - `GET /api/spaces/:space/brand/logo` — the space's own logo, else the instance
 *    logo; 404 when neither exists or the space is unknown/unreadable (one 404 for all).
 *  - `PUT` / `DELETE /api/theme/brand/logo`, `/api/spaces/:space/brand/logo` and
 *    `/api/theme/brand/favicon` — write or remove `_meta/brand/<kind>.svg` together with
 *    the `brand.<kind>` pointer in `_meta/theme.yaml`, in ONE commit, with the caller's
 *    own provider token and the theme write gates.
 *
 * The GETs are public like `/api/theme` (GET-only exemption in `app.ts`): the sign-in
 * page shows the logo, too. They answer `image/svg+xml`, the ETag is the blob sha.
 * What is served is always the sanitizer's output, also for a file committed directly.
 */

const LOGO_URL = '/api/brand/logo'
const FAVICON_URL = '/api/brand/favicon'

/** Request bodies up to this size reach the handler and get the 422 `brand_too_large`;
 *  beyond it Fastify answers 413 itself. */
const UPLOAD_BODY_LIMIT = 4 * BRAND_MAX_BYTES

/** Brand files and the pointer live on the published state, like the theme. */
const BRAND_BRANCH = 'main'

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

const getSchema = { tags: ['theme'], response: { 404: errorSchema } } as const
const getSpaceSchema = { tags: ['theme'], params: spaceParams, response: { 404: errorSchema } } as const

const writeErrors = {
  403: forbiddenSchema,
  404: errorSchema,
  409: errorSchema,
  422: invalidSchema,
  502: errorSchema,
} as const

const putResponse = {
  type: 'object',
  properties: {
    /** The sanitizer removed or changed something; the cleaned file was committed. */
    sanitized: { type: 'boolean' },
    url: { type: 'string' },
  },
  required: ['sanitized', 'url'],
} as const

const putSchema = { tags: ['theme'], response: { 200: putResponse, ...writeErrors } } as const
const putSpaceSchema = { tags: ['theme'], params: spaceParams, response: { 200: putResponse, ...writeErrors } } as const
const deleteResponses = {
  204: { type: 'null', description: 'The brand file and its pointer were removed.' },
  ...writeErrors,
} as const
const deleteSchema = { tags: ['theme'], response: deleteResponses } as const
const deleteSpaceSchema = { tags: ['theme'], params: spaceParams, response: deleteResponses } as const

function invalid(code: string, path: string, message: string) {
  return { status: 'invalid' as const, errors: [{ code, path, message }] }
}

/** Serves a brand file with its blob sha as strong ETag; 304 on a matching `If-None-Match`. */
function sendSvg(
  req: Pick<FastifyRequest, 'headers'>,
  reply: FastifyReply,
  file: BrandFile,
  cacheControl: string,
): FastifyReply {
  const etag = `"${file.sha}"`
  reply.header('ETag', etag)
  reply.header('Cache-Control', cacheControl)
  // Same hardening as `media.ts`: an SVG opened directly must not run anything.
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
  if (req.headers['if-none-match'] === etag) return reply.code(304).send()
  return reply.type('image/svg+xml').send(file.svg)
}

type UploadCheck = { ok: true; svg: string; sanitized: boolean } | { ok: false; body: ReturnType<typeof invalid> }

/** Size first, then the sanitizer; nothing is committed when this fails. */
function checkUpload(body: unknown): UploadCheck {
  const bytes = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : null
  if (!bytes || bytes.length === 0) {
    return { ok: false, body: invalid('brand_not_svg', 'body', 'the body must be an SVG file (image/svg+xml)') }
  }
  if (bytes.length > BRAND_MAX_BYTES) {
    return { ok: false, body: invalid('brand_too_large', 'body', 'a brand file may be at most 256 KB') }
  }
  try {
    return { ok: true, ...sanitizeBrandSvg(bytes.toString('utf8')) }
  } catch (err) {
    if (err instanceof InvalidSvgError) {
      return { ok: false, body: invalid('brand_not_svg', 'body', 'the body is no SVG with visible content') }
    }
    throw err
  }
}

async function readOptional(target: WriteTarget, path: string): Promise<GitFile | null> {
  try {
    return await target.provider.readFile(target.space.repoRef, path, BRAND_BRANCH)
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/** `_meta/theme.yaml` as an editable document (comments survive); `null` when it is no map. */
function themeDocument(content: string | undefined) {
  const doc = parseDocument(content ?? '')
  if (doc.errors.length > 0) return null
  if (doc.contents !== null && !isMap(doc.contents)) return null
  return doc
}

const themeFileInvalid = () =>
  invalid('theme_file_invalid', 'brand', '_meta/theme.yaml cannot be read as a map — fix it through the theme route first')

/** Commits the SVG and the pointer in one commit; `null` on success. */
async function writeBrand(
  target: WriteTarget,
  kind: BrandKind,
  svg: string,
  reply: FastifyReply,
): Promise<FastifyReply | null> {
  const svgPath = `_meta/${BRAND_FILE_PATHS[kind]}`
  let theme: GitFile | null
  let current: GitFile | null
  try {
    theme = await readOptional(target, INSTANCE_THEME_PATH)
    current = await readOptional(target, svgPath)
  } catch (err) {
    return providerFailure(reply, err)
  }

  const doc = themeDocument(theme?.content)
  if (!doc) return reply.code(422).send(themeFileInvalid())
  try {
    doc.setIn(['brand', kind], BRAND_FILE_PATHS[kind])
  } catch {
    // `brand` exists but is a scalar or a list.
    return reply.code(422).send(themeFileInvalid())
  }

  const changes: FileChange[] = [
    { op: 'write', path: svgPath, content: Buffer.from(svg, 'utf8'), sha: current?.sha },
    { op: 'write', path: INSTANCE_THEME_PATH, content: Buffer.from(doc.toString(), 'utf8'), sha: theme?.sha },
  ]
  try {
    await target.provider.commitFiles(target.space.repoRef, changes, { branch: BRAND_BRANCH, message: `Brand: ${kind}` })
  } catch (err) {
    return providerFailure(reply, err)
  }
  return null
}

/** Removes the file the pointer names (default path without one) and the pointer; 404 when
 *  neither exists, `null` on success. An emptied `brand` block or theme file goes, too. */
async function removeBrand(
  target: WriteTarget,
  kind: BrandKind,
  source: 'instance' | 'space',
  reply: FastifyReply,
): Promise<FastifyReply | null> {
  let theme: GitFile | null
  try {
    theme = await readOptional(target, INSTANCE_THEME_PATH)
  } catch (err) {
    return providerFailure(reply, err)
  }
  const doc = themeDocument(theme?.content)
  if (!doc) return reply.code(422).send(themeFileInvalid())

  const hasPointer = theme !== null && doc.hasIn(['brand', kind])
  // Only a valid pointer (relative, under brand/) names the file to delete.
  const pointer = hasPointer
    ? parseThemeFile({ brand: { [kind]: doc.getIn(['brand', kind]) } }, source).file.brand?.[kind]
    : undefined
  const svgPath = `_meta/${pointer ?? BRAND_FILE_PATHS[kind]}`

  let current: GitFile | null
  try {
    current = await readOptional(target, svgPath)
  } catch (err) {
    return providerFailure(reply, err)
  }
  if (!current && !hasPointer) {
    return reply.code(404).send({ status: 'not_found', reason: `There is no ${kind} to remove.` })
  }

  const changes: FileChange[] = []
  if (current) changes.push({ op: 'delete', path: svgPath, sha: current.sha })
  if (hasPointer && theme) {
    doc.deleteIn(['brand', kind])
    const brand = doc.get('brand')
    if (isMap(brand) && brand.items.length === 0) doc.delete('brand')
    if (isMap(doc.contents) && doc.contents.items.length === 0) {
      changes.push({ op: 'delete', path: INSTANCE_THEME_PATH, sha: theme.sha })
    } else {
      changes.push({ op: 'write', path: INSTANCE_THEME_PATH, content: Buffer.from(doc.toString(), 'utf8'), sha: theme.sha })
    }
  }
  try {
    await target.provider.commitFiles(target.space.repoRef, changes, { branch: BRAND_BRANCH, message: `Brand: remove ${kind}` })
  } catch (err) {
    return err instanceof NotFoundError
      ? reply.code(404).send({ status: 'not_found', reason: `There is no ${kind} to remove.` })
      : providerFailure(reply, err)
  }
  return null
}

function registerBrandWriteRoutes(instance: FastifyInstance, gateDeps: NewPageGateDeps, deps: ThemeDeps): void {
  async function upload(
    body: unknown,
    reply: FastifyReply,
    target: WriteTarget,
    kind: BrandKind,
    url: string,
    invalidate: () => void,
  ) {
    const checked = checkUpload(body)
    if (!checked.ok) return reply.code(422).send(checked.body)
    const failed = await writeBrand(target, kind, checked.svg, reply)
    if (failed) return failed
    invalidate()
    return reply.code(200).send({ sanitized: checked.sanitized, url })
  }

  for (const kind of ['logo', 'favicon'] as const) {
    const url = kind === 'logo' ? LOGO_URL : FAVICON_URL

    instance.put(`/api/theme/brand/${kind}`, { schema: putSchema, bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
      const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      return upload(req.body, reply, target, kind, url, invalidateInstanceTheme)
    })

    instance.delete(`/api/theme/brand/${kind}`, { schema: deleteSchema }, async (req, reply) => {
      const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const failed = await removeBrand(target, kind, 'instance', reply)
      if (failed) return failed
      invalidateInstanceTheme()
      return reply.code(204).send()
    })
  }

  // A space has a logo but no favicon (addendum §5).
  instance.put<{ Params: { space: string } }>(
    '/api/spaces/:space/brand/logo',
    { schema: putSpaceSchema, bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      // Unknown/unreadable space → 404, no linked account / no push right → 403.
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const spaceId = target.space.id
      const url = `/api/spaces/${encodeURIComponent(spaceId)}/brand/logo`
      return upload(req.body, reply, target, 'logo', url, () => invalidateSpaceTheme(spaceId))
    },
  )

  instance.delete<{ Params: { space: string } }>(
    '/api/spaces/:space/brand/logo',
    { schema: deleteSpaceSchema },
    async (req, reply) => {
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const failed = await removeBrand(target, 'logo', 'space', reply)
      if (failed) return failed
      invalidateSpaceTheme(target.space.id)
      return reply.code(204).send()
    },
  )
}

export function registerBrandRoutes(app: FastifyInstance, deps: ThemeDeps): void {
  /** Same check as `theme.ts#readableSpace`; anonymous callers pass `''`. */
  async function readableSpace(spaceId: string, userId: string): Promise<SpaceConfig | null> {
    const space = deps.spaces?.find((s) => s.id === spaceId)
    if (!space) return null
    if (deps.access && !(await deps.access.canRead(userId, space))) return null
    return space
  }

  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ status: 'not_found', reason: `There is no ${what}.` })

  app.register(async (instance) => {
    // Uploads are raw bytes of any declared type: a PNG sent as image/png must reach the
    // handler and get the 422 `brand_not_svg`, not Fastify's 415. Scoped to this plugin.
    instance.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (_req, body, done) => {
      done(null, body)
    })

    instance.get('/api/brand/logo', { schema: getSchema }, async (req, reply) => {
      const file = await loadBrandFile(deps, { kind: 'instance' }, 'logo', req.log)
      return file ? sendSvg(req, reply, file, 'public, max-age=300') : notFound(reply, 'logo')
    })

    instance.get('/api/brand/favicon', { schema: getSchema }, async (req, reply) => {
      const file = await loadBrandFile(deps, { kind: 'instance' }, 'favicon', req.log)
      return file ? sendSvg(req, reply, file, 'public, max-age=300') : notFound(reply, 'favicon')
    })

    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/brand/logo',
      { schema: getSpaceSchema },
      async (req, reply) => {
        const space = await readableSpace(req.params.space, req.user?.id ?? '')
        if (!space) return notFound(reply, 'logo')
        const file =
          (await loadBrandFile(deps, { kind: 'space', space }, 'logo', req.log))
          ?? (await loadBrandFile(deps, { kind: 'instance' }, 'logo', req.log))
        // `private`: the answer depends on the caller's read access to the space, so a
        // shared cache must not hand it to someone else.
        return file ? sendSvg(req, reply, file, 'private, max-age=300') : notFound(reply, 'logo')
      },
    )

    const gateDeps = themeWriteGateDeps(deps)
    if (gateDeps) registerBrandWriteRoutes(instance, gateDeps, deps)
  })
}
