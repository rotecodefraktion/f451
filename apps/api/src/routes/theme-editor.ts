import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  AA_THRESHOLDS,
  checkContrast,
  checkRules,
  DEFAULT_THRESHOLDS,
  resolveTheme,
  type ParsedTheme,
  type ThemeLayer,
} from '@f451/design-tokens'
import type { SpaceConfig } from '../spaces/config.js'
import { loadContrastConfig } from '../theme/contrast-config.js'
import { instancePseudoSpace, loadInstanceTheme } from '../theme/instance-theme.js'
import { layersOf, type LibraryScope } from '../theme/library.js'
import { loadSpaceTheme } from '../theme/space-theme.js'
import { loadFontSet, loadStylesheetState, type StylesheetScope } from '../theme/stylesheet.js'
import { loadUserTheme } from '../theme/user-theme.js'
import type { ThemeDeps } from './theme.js'

/**
 * Read routes of the appearance settings page (theming Stage 5).
 *
 * `GET /api/theme/scopes` lists what the caller can open in the editor: the
 * instance (when `F451_INSTANCE_CONFIG` is set) and every readable space, each
 * with `canWrite`. `GET /api/theme/editor` answers everything the page needs for
 * one scope in a single response (July spec, chapter "Bedienung"): the scope's
 * own file, the chain below it (the "Vorgabe" column), the resolved chain with
 * origins, the contrast thresholds and every finding.
 *
 * Both sit behind the normal session gate (no public exemption in `app.ts`).
 * `canWrite` uses the same checks as the write routes (linked account + push
 * right, `routes/drafts.ts#resolveSpaceWriteGate`) but is a boolean here, never
 * a 403. An unknown and an unreadable space answer the same 404.
 *
 * Stage 6 adds the scope `user` ("Meine Einstellungen", addendum §7): the
 * caller's personal theme from `user_settings`, on top of the instance (no
 * space layer — it applies in every space). Available with `db` and a session
 * user; an API token caller does not get it (`/api/me/theme` is session only).
 */

const objectSchema = { type: 'object', additionalProperties: true } as const

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

/** The scope's theme stylesheet for the settings strip (f451#61); `null` for the user scope. */
const stylesheetSchema = {
  type: ['object', 'null'],
  properties: {
    status: { type: 'string', enum: ['ok', 'too_large', 'invalid', 'missing', 'unreadable'] },
    bytes: { type: ['integer', 'null'] },
    sha: { type: ['string', 'null'] },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, line: { type: 'integer' }, message: { type: 'string' } },
        required: ['code', 'line', 'message'],
      },
    },
    fonts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, bytes: { type: ['integer', 'null'] }, ok: { type: 'boolean' } },
        required: ['name', 'bytes', 'ok'],
      },
    },
  },
  required: ['status', 'bytes', 'sha', 'problems', 'fonts'],
} as const

const scopesSchema = {
  tags: ['theme'],
  response: {
    200: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { available: { type: 'boolean' } },
          required: ['available'],
        },
        instance: {
          type: 'object',
          properties: { available: { type: 'boolean' }, canWrite: { type: 'boolean' } },
          required: ['available', 'canWrite'],
        },
        spaces: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' }, canWrite: { type: 'boolean' } },
            required: ['id', 'name', 'canWrite'],
          },
        },
      },
      required: ['user', 'instance', 'spaces'],
    },
  },
} as const

// `scope` is checked in the handler, not by an `enum` here: an AJV rejection
// would answer in Fastify's own error shape instead of the 400 below.
const editorSchema = {
  tags: ['theme'],
  querystring: {
    type: 'object',
    properties: { scope: { type: 'string' }, space: { type: 'string' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          properties: { kind: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' } },
          required: ['kind'],
        },
        canWrite: { type: 'boolean' },
        file: { type: ['object', 'null'], additionalProperties: true },
        problems: { type: 'array', items: objectSchema },
        belowLayers: { type: 'array', items: objectSchema },
        below: objectSchema,
        resolved: objectSchema,
        thresholds: objectSchema,
        defaults: objectSchema,
        aa: objectSchema,
        thresholdsSource: { type: 'string', enum: ['default', 'instance'] },
        note: { type: ['string', 'null'] },
        findings: { type: 'array', items: objectSchema },
        rules: { type: 'array', items: objectSchema },
        stylesheet: stylesheetSchema,
      },
      required: [
        'scope',
        'canWrite',
        'file',
        'problems',
        'belowLayers',
        'below',
        'resolved',
        'thresholds',
        'defaults',
        'aa',
        'thresholdsSource',
        'note',
        'findings',
        'rules',
        'stylesheet',
      ],
    },
    400: errorSchema,
    404: errorSchema,
  },
} as const

type EditorScope = { kind: 'user' } | { kind: 'instance' } | { kind: 'space'; id: string; name: string }

interface EditorStylesheet {
  status: 'ok' | 'too_large' | 'invalid' | 'missing' | 'unreadable'
  bytes: number | null
  sha: string | null
  problems: { code: string; line: number; message: string }[]
  fonts: { name: string; bytes: number | null; ok: boolean }[]
}

/**
 * State of `_meta/theme.css` and the fonts under `_meta/fonts/` of one scope,
 * from the same cached loaders that serve them (`theme/stylesheet.ts`). The font
 * set has real sizes: the listing carries none, so the loader reads the files —
 * once per 5-minute cache window, shared with the font route.
 */
async function editorStylesheet(
  deps: ThemeDeps,
  scope: StylesheetScope,
  log: FastifyRequest['log'],
): Promise<EditorStylesheet> {
  const [state, fonts] = await Promise.all([loadStylesheetState(deps, scope, log), loadFontSet(deps, scope, log)])
  const hasFile = state.status === 'ok' || state.status === 'too_large' || state.status === 'invalid'
  return {
    status: state.status,
    bytes: hasFile ? state.bytes : null,
    sha: hasFile ? state.sha : null,
    problems:
      state.status === 'invalid' ? state.problems.map((p) => ({ code: p.code, line: p.line, message: p.message })) : [],
    fonts: fonts.map((f) => ({ name: f.name, bytes: f.size, ok: f.problem === null })),
  }
}

export function registerThemeEditorRoutes(app: FastifyInstance, deps: ThemeDeps): void {
  /** The personal theme scope needs the database and a session user (not an API token). */
  function userScopeAvailable(req: FastifyRequest): boolean {
    return Boolean(deps.db && req.user?.id && req.apiTokenScope == null)
  }

  /** The configured space if `userId` may read it, else `null` (same check as `theme.ts#readableSpace`). */
  async function readableSpace(spaceId: string, userId: string): Promise<SpaceConfig | null> {
    const space = deps.spaces?.find((s) => s.id === spaceId)
    if (!space) return null
    if (deps.access && !(await deps.access.canRead(userId, space))) return null
    return space
  }

  /**
   * The write gate of `PUT /api/theme` and `PUT /api/spaces/:space/theme` as a
   * boolean: a linked account and push right. Without auth, without a user or on
   * any provider/database error → `false`.
   */
  async function mayWrite(userId: string, space: SpaceConfig): Promise<boolean> {
    const { canWrite, getUserProvider } = deps
    if (!userId || !canWrite || !getUserProvider) return false
    try {
      if (!(await getUserProvider(userId, space))) return false
      return await canWrite(userId, space)
    } catch {
      return false
    }
  }

  /** Readable spaces, in configuration order. */
  async function readableSpaces(userId: string): Promise<SpaceConfig[]> {
    const spaces = deps.spaces ?? []
    const readable = await Promise.all(spaces.map((s) => readableSpace(s.id, userId)))
    return readable.filter((s): s is SpaceConfig => s !== null)
  }

  app.register(async (instance) => {
    instance.get('/api/theme/scopes', { schema: scopesSchema }, async (req) => {
      const userId = req.user?.id ?? ''
      const cfg = deps.instanceConfig
      const spaces = await readableSpaces(userId)
      const [instanceWrite, spaceWrites] = await Promise.all([
        cfg ? mayWrite(userId, instancePseudoSpace(cfg)) : Promise.resolve(false),
        Promise.all(spaces.map((s) => mayWrite(userId, s))),
      ])
      return {
        user: { available: userScopeAvailable(req) },
        instance: { available: Boolean(cfg), canWrite: instanceWrite },
        spaces: spaces.map((s, i) => ({ id: s.id, name: s.name, canWrite: spaceWrites[i]! })),
      }
    })

    instance.get<{ Querystring: { scope?: string; space?: string } }>(
      '/api/theme/editor',
      { schema: editorSchema },
      async (req, reply) => {
        const userId = req.user?.id ?? ''
        const { scope: kind, space: spaceId } = req.query
        if (kind !== 'user' && kind !== 'instance' && kind !== 'space') {
          return reply.code(400).send({ status: 'invalid', reason: 'scope must be "user", "instance" or "space".' })
        }

        const instanceTheme = await loadInstanceTheme(deps, req.log)
        // `use` resolved before mixing (addendum §3): the instance layer with its template.
        const instanceLayers = await layersOf(deps, instanceTheme, { kind: 'instance' }, req.log)
        let scope: EditorScope
        let own: ParsedTheme | null
        let ownScope: LibraryScope
        let belowLayers: ThemeLayer[]
        let canWrite: boolean
        // "Meine Einstellungen" has no stylesheet (a user has no repository).
        let stylesheetScope: StylesheetScope | null = null

        if (kind === 'user') {
          if (!deps.db || !userScopeAvailable(req)) {
            return reply.code(404).send({ status: 'not_found', reason: 'No personal theme is available here.' })
          }
          scope = { kind: 'user' }
          own = await loadUserTheme(deps.db, userId)
          ownScope = { kind: 'instance' }
          belowLayers = instanceLayers
          canWrite = true
        } else if (kind === 'instance') {
          const cfg = deps.instanceConfig
          if (!cfg) {
            return reply.code(404).send({ status: 'not_found', reason: 'No instance repository is configured.' })
          }
          scope = { kind: 'instance' }
          own = instanceTheme
          ownScope = { kind: 'instance' }
          belowLayers = []
          canWrite = await mayWrite(userId, instancePseudoSpace(cfg))
          stylesheetScope = { kind: 'instance' }
        } else {
          if (!spaceId) {
            return reply.code(400).send({ status: 'invalid', reason: 'scope=space needs a space parameter.' })
          }
          const space = await readableSpace(spaceId, userId)
          if (!space) {
            return reply.code(404).send({ status: 'not_found', reason: `Space "${spaceId}" is not known.` })
          }
          scope = { kind: 'space', id: space.id, name: space.name }
          own = deps.providerRegistry
            ? await loadSpaceTheme({ providerRegistry: deps.providerRegistry, now: deps.now }, space, req.log)
            : null
          ownScope = { kind: 'space', space }
          belowLayers = instanceLayers
          canWrite = await mayWrite(userId, space)
          stylesheetScope = { kind: 'space', space }
        }

        const below = resolveTheme(belowLayers)
        const resolved = own
          ? resolveTheme([...belowLayers, ...(await layersOf(deps, own, ownScope, req.log))])
          : below
        const contrast = await loadContrastConfig(deps, req.log)
        const stylesheet = stylesheetScope ? await editorStylesheet(deps, stylesheetScope, req.log) : null

        return {
          scope,
          canWrite,
          file: own?.file ?? null,
          problems: own ? [...own.errors, ...own.warnings] : [],
          belowLayers,
          below,
          resolved,
          thresholds: contrast.thresholds,
          defaults: DEFAULT_THRESHOLDS,
          aa: AA_THRESHOLDS,
          thresholdsSource: contrast.source,
          note: contrast.note,
          findings: checkContrast(resolved, contrast.thresholds),
          rules: checkRules(resolved),
          stylesheet,
        }
      },
    )
  })
}
