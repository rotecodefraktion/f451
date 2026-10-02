import type { FastifyInstance, FastifyReply } from 'fastify'
import { AA_THRESHOLDS, DEFAULT_THRESHOLDS } from '@f451/design-tokens'
import type { GitProvider } from '@f451/git-provider'
import { ConflictError, NotFoundError, ProviderError } from '@f451/git-provider'
import type { SpaceConfig } from '../spaces/config.js'
import {
  checkThresholds,
  CONTRAST_CONFIG_PATH,
  CONTRAST_CONFIG_REF,
  defaultContrastConfig,
  invalidateContrastThresholds,
  loadContrastConfig,
  NOTE_MAX_LENGTH,
  serializeContrastFile,
  THRESHOLD_KEYS,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  type ContrastConfig,
} from '../theme/contrast-config.js'
import { instancePseudoSpace, invalidateInstanceTheme, type InstanceThemeDeps } from '../theme/instance-theme.js'
import { invalidateAllSpaceThemes } from '../theme/space-theme.js'

/**
 * Contrast thresholds of the instance (theming Stage 4, unit 4.2):
 *
 *  - `GET /api/theme/contrast` — effective thresholds, defaults, AA reference, `note`,
 *    `source` and what was ignored while reading. Any session (normal `/api/*` gate).
 *  - `PUT /api/theme/contrast` — writes `_meta/contrast.yaml` to `main` of the instance
 *    repo with the caller's own provider token. The body replaces the file: keys left
 *    out fall back to their defaults.
 *  - `DELETE /api/theme/contrast` — back to the defaults (removes the file).
 *
 * Writing needs push right on the instance repo, checked like a space write
 * (`drafts.ts#resolveSpaceWriteGate`): linked account (else 403 `connect`), then
 * `canWrite` on the instance pseudo space (else 403). Without `F451_INSTANCE_CONFIG`
 * there is nowhere to write → 404. A threshold change changes which themes pass, so
 * every theme cache is emptied along with the thresholds cache.
 */

export interface ThemeContrastDeps extends InstanceThemeDeps {
  /** Push-right probe (`auth/permissions.ts#canWriteSpace`); unset without auth → no write routes. */
  canWrite?: (userId: string, space: SpaceConfig) => Promise<boolean>
  /** The caller's own provider (`drafts/user-provider.ts`); unset without auth → no write routes. */
  getUserProvider?: (userId: string, space: SpaceConfig) => Promise<GitProvider | null>
}

const thresholdsSchema = {
  type: 'object',
  properties: {
    readingText: { type: 'number' },
    shortText: { type: 'number' },
    nonText: { type: 'number' },
    incidental: { type: 'number' },
  },
  required: ['readingText', 'shortText', 'nonText', 'incidental'],
} as const

const problemSchema = {
  type: 'object',
  properties: { code: { type: 'string' }, key: { type: 'string' }, message: { type: 'string' } },
  required: ['code', 'message'],
} as const

const stateSchema = {
  type: 'object',
  properties: {
    thresholds: thresholdsSchema,
    defaults: thresholdsSchema,
    aa: thresholdsSchema,
    source: { type: 'string', enum: ['default', 'instance'] },
    note: { type: ['string', 'null'] },
    problems: { type: 'array', items: problemSchema },
  },
  required: ['thresholds', 'defaults', 'aa', 'source', 'note', 'problems'],
} as const

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const forbiddenSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, action: { type: 'string' } },
  required: ['error'],
} as const

const unprocessableSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    key: { type: 'string' },
    min: { type: 'number' },
    max: { type: 'number' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const writeResponses = {
  200: stateSchema,
  401: errorSchema,
  403: forbiddenSchema,
  404: errorSchema,
  409: errorSchema,
  502: errorSchema,
} as const

// No property types on the body: Fastify's Ajv coerces types (`"4.5"` → 4.5), and a
// threshold must be a number as sent. The handler checks every field itself.
const putSchema = {
  tags: ['theme'],
  body: { type: 'object' },
  response: { ...writeResponses, 422: unprocessableSchema },
} as const

const deleteSchema = { tags: ['theme'], response: writeResponses } as const

const getSchema = { tags: ['theme'], response: { 200: stateSchema } } as const

function stateBody(config: ContrastConfig) {
  return {
    thresholds: config.thresholds,
    defaults: DEFAULT_THRESHOLDS,
    aa: AA_THRESHOLDS,
    source: config.source,
    note: config.note,
    problems: config.problems,
  }
}

function providerErrorReply(reply: FastifyReply, err: unknown, action: string): FastifyReply {
  if (err instanceof ProviderError && err.status === 403) {
    // The provider enforces push right on `main`; its 403 is the authoritative "no".
    return reply.code(403).send({ error: `Your linked account may not ${action} the contrast thresholds.` })
  }
  if (err instanceof ConflictError) {
    return reply
      .code(409)
      .send({ status: 'conflict', reason: 'contrast.yaml changed in the meantime; reload and try again.' })
  }
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider error: ${message}` })
}

/** Every cache whose content depends on the thresholds. */
function invalidateAfterThresholdChange(): void {
  invalidateContrastThresholds()
  invalidateInstanceTheme()
  invalidateAllSpaceThemes()
}

export function registerThemeContrastRoutes(app: FastifyInstance, deps: ThemeContrastDeps): void {
  app.register(async (instance) => {
    instance.get('/api/theme/contrast', { schema: getSchema }, async (req) => {
      return stateBody(await loadContrastConfig(deps, req.log))
    })

    const { canWrite, getUserProvider } = deps
    if (!canWrite || !getUserProvider) return

    type Gate = { ok: true; provider: GitProvider } | { ok: false; status: number; body: unknown }

    /** Session → instance repo configured (404) → linked account (403 connect) → push right (403). */
    async function writeGate(userId: string | undefined): Promise<Gate> {
      if (!userId) return { ok: false, status: 401, body: { status: 'unauthorized', reason: 'Session required.' } }
      const cfg = deps.instanceConfig
      if (!cfg) {
        return {
          ok: false,
          status: 404,
          body: { status: 'not_found', reason: 'No instance repository configured (F451_INSTANCE_CONFIG).' },
        }
      }
      const space = instancePseudoSpace(cfg)
      const provider = await getUserProvider!(userId, space)
      if (!provider) {
        return {
          ok: false,
          status: 403,
          body: { error: 'No linked provider account. Link your account first.', action: 'connect' },
        }
      }
      if (!(await canWrite!(userId, space))) {
        return {
          ok: false,
          status: 403,
          body: { error: 'Your linked account may not write to the instance repository.' },
        }
      }
      return { ok: true, provider }
    }

    /** Blob SHA of the current file on `main`, `undefined` when there is none. Other errors propagate. */
    async function currentSha(provider: GitProvider): Promise<string | undefined> {
      try {
        return (await provider.readFile(deps.instanceConfig!.repoRef, CONTRAST_CONFIG_PATH, CONTRAST_CONFIG_REF)).sha
      } catch (err) {
        if (err instanceof NotFoundError) return undefined
        throw err
      }
    }

    instance.put('/api/theme/contrast', { schema: putSchema }, async (req, reply) => {
      const gate = await writeGate(req.user?.id)
      if (!gate.ok) return reply.code(gate.status as 401 | 403 | 404).send(gate.body)

      const body = (req.body ?? {}) as Record<string, unknown>
      const allowed = new Set<string>([...THRESHOLD_KEYS, 'note'])
      const unknownKey = Object.keys(body).find((k) => !allowed.has(k))
      if (unknownKey !== undefined) {
        return reply
          .code(422)
          .send({ error: 'key_unknown', key: unknownKey, message: `Unknown key "${unknownKey}".` })
      }

      const checked = checkThresholds(body)
      if (!checked.ok) {
        const { code, key, message } = checked.problem
        return reply.code(422).send({
          error: code,
          ...(key ? { key } : {}),
          ...(code === 'threshold_out_of_range' ? { min: THRESHOLD_MIN, max: THRESHOLD_MAX } : {}),
          message,
        })
      }

      let note: string | null = null
      const rawNote = body.note
      if (rawNote !== undefined && rawNote !== null) {
        if (typeof rawNote !== 'string' || rawNote.length > NOTE_MAX_LENGTH) {
          return reply.code(422).send({
            error: 'note_invalid',
            key: 'note',
            message: `note must be text of at most ${NOTE_MAX_LENGTH} characters.`,
          })
        }
        note = rawNote.trim() || null
      }

      const repo = deps.instanceConfig!.repoRef
      try {
        const sha = await currentSha(gate.provider)
        await gate.provider.writeFile(repo, CONTRAST_CONFIG_PATH, serializeContrastFile(checked.set, note), {
          branch: CONTRAST_CONFIG_REF,
          message: 'Contrast thresholds',
          ...(sha ? { sha } : {}),
        })
      } catch (err) {
        return providerErrorReply(reply, err, 'change')
      }

      invalidateAfterThresholdChange()
      return stateBody({
        thresholds: { ...DEFAULT_THRESHOLDS, ...checked.set },
        source: 'instance',
        note,
        problems: [],
      })
    })

    instance.delete('/api/theme/contrast', { schema: deleteSchema }, async (req, reply) => {
      const gate = await writeGate(req.user?.id)
      if (!gate.ok) return reply.code(gate.status as 401 | 403 | 404).send(gate.body)

      const repo = deps.instanceConfig!.repoRef
      try {
        const sha = await currentSha(gate.provider)
        // No file → already at the defaults; nothing to commit.
        if (sha) {
          await gate.provider.deleteFile(repo, CONTRAST_CONFIG_PATH, {
            branch: CONTRAST_CONFIG_REF,
            message: 'Contrast thresholds: reset to defaults',
            sha,
          })
        }
      } catch (err) {
        return providerErrorReply(reply, err, 'reset')
      }

      invalidateAfterThresholdChange()
      return stateBody(defaultContrastConfig())
    })
  })
}
