import type { FastifyInstance, FastifyReply } from 'fastify'
import { builtinTemplates } from '@f451/design-tokens'
import type { SpaceConfig } from '../spaces/config.js'
import { invalidateInstanceTheme, loadInstanceTheme } from '../theme/instance-theme.js'
import { layersOf, loadLibrary, TEMPLATE_SLUG, templatePath, type LibraryEntry } from '../theme/library.js'
import { invalidateSpaceTheme } from '../theme/space-theme.js'
import { resolveNewPageWriteContext, type NewPageGateDeps } from './drafts.js'
import {
  commitThemeFile,
  forbiddenSchema,
  instanceWriteTarget,
  invalidSchema,
  removeThemeFile,
  THEME_BODY_LIMIT,
  themeFileSchema,
  themeWriteGateDeps,
  validateThemeWrite,
  type ThemeDeps,
  type WriteTarget,
} from './theme.js'

/**
 * Theme library routes (theming addendum §3):
 *
 *  - `GET /api/theme/library` — the instance library (built-ins and the instance repo's
 *    `_meta/themes/*.yaml`) as `{ templates: LibraryEntry[] }`.
 *  - `GET /api/spaces/:space/theme/library` — the same plus the space's own templates;
 *    needs read access, an unknown and an unreadable space answer the same 404.
 *  - `PUT` / `DELETE /api/theme/library/:slug` and `/api/spaces/:space/theme/library/:slug`
 *    — write or remove `_meta/themes/<slug>.yaml` with the caller's own provider token
 *    (same gates as the theme writes). A template is validated as a theme of its level
 *    (rules and contrast on the chain below plus the template) and must not carry `use`
 *    (`template_no_nesting`). Built-in slugs answer 405 on the instance routes.
 *
 * All of them sit behind the normal session gate (no public exemption in `app.ts`).
 */

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const entrySchema = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    origin: { type: 'string', enum: ['builtin', 'instance', 'space'] },
    file: themeFileSchema,
  },
  required: ['slug', 'name', 'origin', 'file'],
} as const

const listResponse = {
  type: 'object',
  properties: { templates: { type: 'array', items: entrySchema } },
  required: ['templates'],
} as const

const spaceParams = {
  type: 'object',
  properties: { space: { type: 'string' } },
  required: ['space'],
} as const

const slugParams = {
  type: 'object',
  properties: { slug: { type: 'string' } },
  required: ['slug'],
} as const

const spaceSlugParams = {
  type: 'object',
  properties: { space: { type: 'string' }, slug: { type: 'string' } },
  required: ['space', 'slug'],
} as const

const writeErrors = {
  403: forbiddenSchema,
  404: errorSchema,
  405: errorSchema,
  409: errorSchema,
  422: invalidSchema,
  502: errorSchema,
} as const

const getSchema = { tags: ['theme'], response: { 200: listResponse } } as const
const getSpaceSchema = { tags: ['theme'], params: spaceParams, response: { 200: listResponse, 404: errorSchema } } as const

// No `body` schema (precedent `theme.ts#putThemeSchema`): `parseThemeFile` checks every
// key and answers in the 422 shape, an AJV rejection would not.
const putResponse = {
  type: 'object',
  properties: { template: entrySchema },
  required: ['template'],
} as const
const putSchema = { tags: ['theme'], params: slugParams, response: { 200: putResponse, ...writeErrors } } as const
const putSpaceSchema = {
  tags: ['theme'],
  params: spaceSlugParams,
  response: { 200: putResponse, ...writeErrors },
} as const

const deleteResponses = {
  204: { type: 'null', description: 'The template file was removed.' },
  ...writeErrors,
} as const
const deleteSchema = { tags: ['theme'], params: slugParams, response: deleteResponses } as const
const deleteSpaceSchema = { tags: ['theme'], params: spaceSlugParams, response: deleteResponses } as const

function isBuiltin(slug: string): boolean {
  return builtinTemplates().some((t) => t.slug === slug)
}

/** 422 for a slug outside `[a-z0-9-]{1,40}`, 405 for a built-in one on the instance routes; `null` = fine. */
function slugProblem(reply: FastifyReply, slug: string, builtinsLocked: boolean): FastifyReply | null {
  if (!TEMPLATE_SLUG.test(slug)) {
    return reply.code(422).send({
      status: 'invalid',
      errors: [{ code: 'slug_invalid', path: 'slug', message: `"${slug}" is not a template slug — expected [a-z0-9-]{1,40}` }],
    })
  }
  if (builtinsLocked && isBuiltin(slug)) {
    return reply
      .code(405)
      .header('allow', '')
      .send({ status: 'builtin', reason: `"${slug}" is a built-in template; it can be neither overwritten nor removed.` })
  }
  return null
}

export function registerThemeLibraryRoutes(app: FastifyInstance, deps: ThemeDeps): void {
  /** The configured space if `userId` may read it, else `null` (same check as `theme.ts#readableSpace`). */
  async function readableSpace(spaceId: string, userId: string): Promise<SpaceConfig | null> {
    const space = deps.spaces?.find((s) => s.id === spaceId)
    if (!space) return null
    if (deps.access && !(await deps.access.canRead(userId, space))) return null
    return space
  }

  app.register(async (instance) => {
    instance.get('/api/theme/library', { schema: getSchema }, async (req) => {
      return { templates: await loadLibrary(deps, { kind: 'instance' }, req.log) }
    })

    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/theme/library',
      { schema: getSpaceSchema },
      async (req, reply) => {
        const space = await readableSpace(req.params.space, req.user?.id ?? '')
        if (!space) {
          return reply.code(404).send({ status: 'not_found', reason: `Space "${req.params.space}" is not known.` })
        }
        return { templates: await loadLibrary(deps, { kind: 'space', space }, req.log) }
      },
    )

    const gateDeps = themeWriteGateDeps(deps)
    if (gateDeps) registerLibraryWriteRoutes(instance, deps, gateDeps)
  })
}

function registerLibraryWriteRoutes(instance: FastifyInstance, deps: ThemeDeps, gateDeps: NewPageGateDeps): void {
  /** Validate, commit, answer with the new entry. `inherited` is the chain below the template's level. */
  async function writeTemplate(
    reply: FastifyReply,
    target: WriteTarget,
    slug: string,
    body: unknown,
    origin: 'instance' | 'space',
    log: Parameters<typeof loadInstanceTheme>[1],
  ): Promise<{ entry: LibraryEntry } | FastifyReply> {
    const inherited =
      origin === 'space' ? await layersOf(deps, await loadInstanceTheme(deps, log), { kind: 'instance' }, log) : []
    const checked = await validateThemeWrite(deps, body, origin, inherited, { asTemplate: slug }, log)
    if (!checked.ok) return reply.code(422).send(checked.body)

    const { file } = checked.parsed
    const failed = await commitThemeFile(
      target,
      templatePath(slug),
      file,
      `Theme template: ${file.name ?? slug}`,
      reply,
    )
    if (failed) return failed
    return { entry: { slug, name: file.name ?? slug, origin, file } }
  }

  instance.put<{ Params: { slug: string } }>(
    '/api/theme/library/:slug',
    { schema: putSchema, bodyLimit: THEME_BODY_LIMIT },
    async (req, reply) => {
      const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const bad = slugProblem(reply, req.params.slug, true)
      if (bad) return bad

      const result = await writeTemplate(reply, target, req.params.slug, req.body, 'instance', req.log)
      if (!('entry' in result)) return result
      // Clears the instance library as well (`instance-theme.ts`).
      invalidateInstanceTheme()
      return reply.code(200).send({ template: result.entry })
    },
  )

  instance.delete<{ Params: { slug: string } }>(
    '/api/theme/library/:slug',
    { schema: deleteSchema },
    async (req, reply) => {
      const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const bad = slugProblem(reply, req.params.slug, true)
      if (bad) return bad

      // A `use` pointing here is not counted: it falls back to "no template" on read (addendum §3).
      const slug = req.params.slug
      const failed = await removeThemeFile(target, templatePath(slug), `Theme template: remove ${slug}`, reply)
      if (failed) return failed
      invalidateInstanceTheme()
      return reply.code(204).send()
    },
  )

  instance.put<{ Params: { space: string; slug: string } }>(
    '/api/spaces/:space/theme/library/:slug',
    { schema: putSpaceSchema, bodyLimit: THEME_BODY_LIMIT },
    async (req, reply) => {
      // Unknown/unreadable space → 404, no linked account / no push right → 403.
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const bad = slugProblem(reply, req.params.slug, false)
      if (bad) return bad

      const result = await writeTemplate(reply, target, req.params.slug, req.body, 'space', req.log)
      if (!('entry' in result)) return result
      // Clears the space's library as well (`space-theme.ts`).
      invalidateSpaceTheme(target.space.id)
      return reply.code(200).send({ template: result.entry })
    },
  )

  instance.delete<{ Params: { space: string; slug: string } }>(
    '/api/spaces/:space/theme/library/:slug',
    { schema: deleteSpaceSchema },
    async (req, reply) => {
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)
      const bad = slugProblem(reply, req.params.slug, false)
      if (bad) return bad

      const slug = req.params.slug
      const failed = await removeThemeFile(target, templatePath(slug), `Theme template: remove ${slug}`, reply)
      if (failed) return failed
      invalidateSpaceTheme(target.space.id)
      return reply.code(204).send()
    },
  )
}
