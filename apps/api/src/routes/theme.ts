import type { FastifyInstance } from 'fastify'
import {
  resolveTheme,
  toCssDeclarations,
  type LayerSource,
  type ParsedTheme,
  type ThemeLayer,
} from '@f451/design-tokens'
import type { SpaceAccess } from '../auth/permissions.js'
import type { SpaceConfig } from '../spaces/config.js'
import { loadInstanceTheme, type InstanceThemeDeps } from '../theme/instance-theme.js'
import { loadSpaceTheme } from '../theme/space-theme.js'

/**
 * Theming read path: the instance theme (Stage 2) and a space theme (Stage 3)
 * as files, and the resolved chain as CSS declarations for the layout's inline
 * `<style>`.
 *
 * `/api/theme` and `/api/theme/resolved` are public (exempted from the session
 * gate in `app.ts`): the look must not depend on being signed in — the sign-in
 * page and anonymous readers get the same colours (plan Review Focus 4). They
 * reveal nothing but the look itself. A missing theme is a normal state and
 * answers 200 with empty values, never 404 (404 stays "does not exist OR no
 * access").
 *
 * `/api/spaces/:space/theme` sits behind the session gate like every other
 * `/api/spaces/*` route and needs read access to the space; an unknown and an
 * unreadable space answer the same 404.
 */

export interface ThemeDeps extends InstanceThemeDeps {
  /** Configured spaces (`F451_SPACES`); unset → no space layer, every space route answers 404. */
  spaces?: readonly SpaceConfig[]
  /** Read-access check, set only when auth is active; unset → every configured space is readable
   *  (same convention as the other space read routes). */
  access?: SpaceAccess
}

const tokenMapSchema = { type: 'object', additionalProperties: { type: 'string' } } as const

const problemSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    token: { type: 'string' },
    path: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['code', 'path', 'message'],
} as const

const themeFileSchema = {
  type: ['object', 'null'],
  properties: {
    name: { type: 'string' },
    use: { type: 'string' },
    base: tokenMapSchema,
    light: tokenMapSchema,
    dark: tokenMapSchema,
    brand: {
      type: 'object',
      properties: { name: { type: 'string' }, logo: { type: 'string' }, favicon: { type: 'string' } },
    },
  },
} as const

const layerSchema = {
  type: ['object', 'null'],
  properties: {
    source: { type: 'string' },
    template: { type: 'string' },
    base: tokenMapSchema,
    light: tokenMapSchema,
    dark: tokenMapSchema,
  },
} as const

const originEntrySchema = {
  type: 'object',
  properties: { source: { type: 'string' }, template: { type: 'string' } },
  required: ['source'],
} as const

const originMapSchema = { type: 'object', additionalProperties: originEntrySchema } as const

const themeResponseSchema = (origin: 'instance' | 'space') =>
  ({
    type: 'object',
    properties: {
      file: themeFileSchema,
      layer: layerSchema,
      warnings: { type: 'array', items: problemSchema },
      errors: { type: 'array', items: problemSchema },
      origin: { type: 'string', enum: [origin] },
    },
    required: ['file', 'layer', 'warnings', 'errors', 'origin'],
  }) as const

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const themeSchema = {
  tags: ['theme'],
  response: { 200: themeResponseSchema('instance') },
} as const

const spaceThemeSchema = {
  tags: ['theme'],
  params: {
    type: 'object',
    properties: { space: { type: 'string' } },
    required: ['space'],
  },
  response: { 200: themeResponseSchema('space'), 404: errorSchema },
} as const

const stringArray = { type: 'array', items: { type: 'string' } } as const

const resolvedSchema = {
  tags: ['theme'],
  querystring: {
    type: 'object',
    properties: { space: { type: 'string' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        css: {
          type: 'object',
          properties: { root: stringArray, light: stringArray, dark: stringArray },
          required: ['root', 'light', 'dark'],
        },
        origin: {
          type: 'object',
          properties: { base: originMapSchema, light: originMapSchema, dark: originMapSchema },
          required: ['base', 'light', 'dark'],
        },
        brand: { type: 'null' },
        layers: { type: 'array', items: { type: 'string' } },
      },
      required: ['css', 'origin', 'brand', 'layers'],
    },
  },
} as const

function themeBody<O extends 'instance' | 'space'>(theme: ParsedTheme | null, origin: O) {
  if (!theme) return { file: null, layer: null, warnings: [], errors: [], origin }
  return { file: theme.file, layer: theme.layer, warnings: theme.warnings, errors: theme.errors, origin }
}

export function registerThemeRoutes(app: FastifyInstance, deps: ThemeDeps): void {
  /** The configured space if `userId` may read it, else `null` (unknown and unreadable look the same).
   *  Anonymous callers pass `''`, as in `versions.ts#readablePage`. */
  async function readableSpace(spaceId: string, userId: string): Promise<SpaceConfig | null> {
    const space = deps.spaces?.find((s) => s.id === spaceId)
    if (!space) return null
    if (deps.access && !(await deps.access.canRead(userId, space))) return null
    return space
  }

  /** Space theme, or `null` without a provider registry (no `F451_SPACES` → nothing to read from). */
  async function spaceTheme(space: SpaceConfig, log: Parameters<typeof loadSpaceTheme>[2]) {
    if (!deps.providerRegistry) return null
    return loadSpaceTheme({ providerRegistry: deps.providerRegistry, now: deps.now }, space, log)
  }

  app.register(async (instance) => {
    instance.get('/api/theme', { schema: themeSchema }, async (req) => {
      return themeBody(await loadInstanceTheme(deps, req.log), 'instance' as const)
    })

    instance.get<{ Params: { space: string } }>(
      '/api/spaces/:space/theme',
      { schema: spaceThemeSchema },
      async (req, reply) => {
        const space = await readableSpace(req.params.space, req.user?.id ?? '')
        if (!space) {
          return reply.code(404).send({ status: 'not_found', reason: `Space "${req.params.space}" is not known.` })
        }
        return themeBody(await spaceTheme(space, req.log), 'space' as const)
      },
    )

    instance.get<{ Querystring: { space?: string } }>(
      '/api/theme/resolved',
      { schema: resolvedSchema },
      async (req) => {
        // An unknown or unreadable `space` is ignored rather than answered with 404: the layout
        // asks for every page, and a wrong id must not break rendering. Stage 6 adds the user layer.
        const instanceTheme = await loadInstanceTheme(deps, req.log)
        const space = req.query.space ? await readableSpace(req.query.space, req.user?.id ?? '') : null
        const spaceThemeParsed = space ? await spaceTheme(space, req.log) : null
        const layers: ThemeLayer[] = [instanceTheme?.layer, spaceThemeParsed?.layer].filter(
          (l): l is ThemeLayer => Boolean(l),
        )
        const resolved = resolveTheme(layers)
        return {
          css: toCssDeclarations(resolved),
          origin: resolved.origin,
          brand: null,
          layers: layers.map((l): LayerSource => l.source),
        }
      },
    )
  })
}
