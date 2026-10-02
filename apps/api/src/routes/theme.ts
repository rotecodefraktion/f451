import type { FastifyInstance } from 'fastify'
import { resolveTheme, toCssDeclarations, type LayerSource, type ThemeLayer } from '@f451/design-tokens'
import { loadInstanceTheme, type InstanceThemeDeps } from '../theme/instance-theme.js'

/**
 * Theming Stage 2 (read path): the instance theme as a file and the resolved
 * chain as CSS declarations for the layout's inline `<style>`.
 *
 * Both routes are public (exempted from the session gate in `app.ts`): the
 * look must not depend on being signed in — the sign-in page and anonymous
 * readers get the same colours (plan Review Focus 4). They reveal nothing but
 * the look itself. A missing theme is a normal state and answers 200 with
 * empty values, never 404 (404 stays "does not exist OR no access").
 */

export type ThemeDeps = InstanceThemeDeps

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

const themeSchema = {
  tags: ['theme'],
  response: {
    200: {
      type: 'object',
      properties: {
        file: themeFileSchema,
        layer: layerSchema,
        warnings: { type: 'array', items: problemSchema },
        errors: { type: 'array', items: problemSchema },
        origin: { type: 'string', enum: ['instance'] },
      },
      required: ['file', 'layer', 'warnings', 'errors', 'origin'],
    },
  },
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

export function registerThemeRoutes(app: FastifyInstance, deps: ThemeDeps): void {
  app.register(async (instance) => {
    instance.get('/api/theme', { schema: themeSchema }, async (req) => {
      const theme = await loadInstanceTheme(deps, req.log)
      if (!theme) return { file: null, layer: null, warnings: [], errors: [], origin: 'instance' as const }
      return {
        file: theme.file,
        layer: theme.layer,
        warnings: theme.warnings,
        errors: theme.errors,
        origin: 'instance' as const,
      }
    })

    instance.get<{ Querystring: { space?: string } }>(
      '/api/theme/resolved',
      { schema: resolvedSchema },
      async (req) => {
        // `space` is accepted but not used yet — Stage 3 adds the space layer (and Stage 6 the user layer).
        const instanceTheme = await loadInstanceTheme(deps, req.log)
        const layers: ThemeLayer[] = [instanceTheme?.layer].filter((l): l is ThemeLayer => Boolean(l))
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
