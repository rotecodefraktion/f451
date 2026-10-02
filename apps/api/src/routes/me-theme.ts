import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  checkContrast,
  checkRules,
  resolveTheme,
  type ContrastFinding,
  type ParsedTheme,
  type ThemeLayer,
  type ThemeProblem,
} from '@f451/design-tokens'
import { eq } from 'drizzle-orm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Db } from '../db/client.js'
import { userSettings } from '../db/schema.js'
import { loadContrastThresholds } from '../theme/contrast-config.js'
import { loadInstanceTheme, type InstanceThemeDeps } from '../theme/instance-theme.js'
import { loadUserTheme, parseUserTheme } from '../theme/user-theme.js'
import {
  contrastFindingSchema,
  describeViolation,
  forbiddenSchema,
  invalidSchema,
  problemSchema,
  THEME_BODY_LIMIT,
  themeFileSchema,
} from './theme.js'

/**
 * Personal theme (theming addendum §2): `GET` / `PUT` / `DELETE /api/me/theme`.
 *
 * Session only: an API token gets 403 `session_required` on every method — the
 * personal theme concerns browsers, tokens have another purpose. The global
 * session gate in `app.ts` answers 401 without any session, and a read-only
 * token's `PUT`/`DELETE` already ends there with its own 403.
 *
 * Validation is the same as for a space file (fail-closed, unknown top-level key
 * rejected on write, cross-token rules → 422), with two differences: a `brand`
 * block is dropped with a warning (a user has no brand), and contrast below the
 * instance thresholds never blocks — the findings come back as `warnings`
 * (the user only harms themselves). Contrast is measured on instance ← user,
 * without a space, because the personal theme applies in every space.
 */

export interface MeThemeDeps extends InstanceThemeDeps {
  db: Db
}

const meThemeResponseSchema = {
  type: 'object',
  properties: {
    file: themeFileSchema,
    problems: { type: 'array', items: problemSchema },
    warnings: { type: 'array', items: contrastFindingSchema },
  },
  required: ['file', 'problems', 'warnings'],
} as const

const sessionErrors = { 403: forbiddenSchema } as const

const getSchema = {
  tags: ['theme'],
  querystring: {
    type: 'object',
    properties: { format: { type: 'string', enum: ['json', 'yaml'] } },
  },
  response: { 200: meThemeResponseSchema, ...sessionErrors },
} as const

// No `body` schema (precedent `theme.ts#putThemeSchema`): `parseThemeFile` checks every key
// and answers in the 422 shape below, an AJV rejection would not.
const putSchema = {
  tags: ['theme'],
  response: { 200: meThemeResponseSchema, ...sessionErrors, 422: invalidSchema },
} as const

const deleteSchema = {
  tags: ['theme'],
  response: {
    204: { type: 'null', description: 'The personal theme was removed (or there was none).' },
    ...sessionErrors,
  },
} as const

const YAML_TYPES = ['application/yaml', 'text/yaml']

function isYamlRequest(req: FastifyRequest): boolean {
  const type = (req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase()
  return YAML_TYPES.includes(type)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A user theme has no brand: the block is removed before parsing, with a note. */
function dropBrand(body: unknown): { input: unknown; problems: ThemeProblem[] } {
  if (!isRecord(body) || body.brand == null) return { input: body, problems: [] }
  const rest = { ...body }
  delete rest.brand
  return {
    input: rest,
    problems: [{ code: 'brand_ignored', path: 'brand', message: 'a personal theme has no brand — the block was ignored' }],
  }
}

export function registerMeThemeRoutes(app: FastifyInstance, deps: MeThemeDeps): void {
  /** Instance ← user, the chain a personal theme is checked against (no space layer). */
  async function chainWith(user: ParsedTheme | null, log: FastifyRequest['log']) {
    const instanceLayer = (await loadInstanceTheme(deps, log))?.layer
    const layers = [instanceLayer, user?.layer].filter((l): l is ThemeLayer => Boolean(l))
    return resolveTheme(layers)
  }

  async function contrastWarnings(
    resolved: ReturnType<typeof resolveTheme>,
    log: FastifyRequest['log'],
  ): Promise<ContrastFinding[]> {
    const thresholds = await loadContrastThresholds(deps, log)
    return checkContrast(resolved, thresholds).filter((f) => f.belowThreshold)
  }

  app.register(async (instance) => {
    // YAML upload, scoped to this plugin (pattern `webhooks.ts`): the raw text is
    // parsed in the handler so a syntax error answers in the 422 shape.
    instance.addContentTypeParser(YAML_TYPES, { parseAs: 'string', bodyLimit: THEME_BODY_LIMIT }, (_req, body, done) => {
      done(null, body)
    })

    instance.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.apiTokenScope != null) {
        return reply.code(403).send({ error: 'session_required' })
      }
      if (!req.user) {
        reply.header('WWW-Authenticate', 'session')
        return reply.code(401).send({ status: 'unauthorized', reason: 'Sign-in required.' })
      }
    })

    instance.get<{ Querystring: { format?: 'json' | 'yaml' } }>(
      '/api/me/theme',
      { schema: getSchema },
      async (req, reply) => {
        const parsed = await loadUserTheme(deps.db, req.user!.id)
        const file = parsed?.file ?? {}
        if (req.query.format === 'yaml') {
          return reply.type('text/yaml; charset=utf-8').send(stringifyYaml(file))
        }
        const warnings = await contrastWarnings(await chainWith(parsed, req.log), req.log)
        const problems = parsed ? [...parsed.errors, ...parsed.warnings] : []
        return reply.code(200).send({ file, problems, warnings })
      },
    )

    instance.put('/api/me/theme', { schema: putSchema, bodyLimit: THEME_BODY_LIMIT }, async (req, reply) => {
      let body: unknown = req.body
      if (isYamlRequest(req)) {
        try {
          body = parseYaml(String(req.body ?? ''))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return reply
            .code(422)
            .send({ status: 'invalid', errors: [{ code: 'yaml_invalid', path: '', message }] })
        }
      }

      const { input, problems } = dropBrand(body)
      const parsed = parseUserTheme(input)
      // Writing rejects an unknown top-level key, like the instance and space writes.
      const errors = [...parsed.errors, ...parsed.warnings.filter((w) => w.code === 'key_unknown')]
      if (errors.length > 0) return reply.code(422).send({ status: 'invalid', errors })

      const resolved = await chainWith(parsed, req.log)
      const violations = checkRules(resolved)
      if (violations.length > 0) {
        return reply
          .code(422)
          .send({ status: 'invalid', rules: violations.map((v) => describeViolation(resolved, v)) })
      }
      const warnings = await contrastWarnings(resolved, req.log)

      await deps.db
        .insert(userSettings)
        .values({ userId: req.user!.id, theme: parsed.file })
        .onConflictDoUpdate({ target: userSettings.userId, set: { theme: parsed.file, updatedAt: new Date() } })

      return reply.code(200).send({ file: parsed.file, problems: [...problems, ...parsed.warnings], warnings })
    })

    instance.delete('/api/me/theme', { schema: deleteSchema }, async (req, reply) => {
      await deps.db.delete(userSettings).where(eq(userSettings.userId, req.user!.id))
      return reply.code(204).send()
    })
  })
}
