import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  attributeValues,
  checkContrast,
  checkRules,
  parseThemeFile,
  resolveTheme,
  toAttributes,
  toCssDeclarations,
  type LayerSource,
  type Origin,
  type ParsedTheme,
  type ResolvedTheme,
  type RuleViolation,
  type ThemeLayer,
} from '@f451/design-tokens'
import type { GitProvider } from '@f451/git-provider'
import { ConflictError, NotFoundError, ProviderError } from '@f451/git-provider'
import { stringify as stringifyYaml } from 'yaml'
import type { SpaceAccess } from '../auth/permissions.js'
import type { Db } from '../db/client.js'
import type { SpaceConfig } from '../spaces/config.js'
import { resolveBrand } from '../theme/brand.js'
import { loadContrastThresholds } from '../theme/contrast-config.js'
import {
  INSTANCE_THEME_PATH,
  instancePseudoSpace,
  invalidateInstanceTheme,
  loadInstanceTheme,
  type InstanceThemeDeps,
} from '../theme/instance-theme.js'
import { findTemplate, layersOf, loadLibrary, templateLayer, type LibraryEntry } from '../theme/library.js'
import { invalidateSpaceTheme, loadSpaceTheme, SPACE_THEME_PATH } from '../theme/space-theme.js'
import { loadUserTheme } from '../theme/user-theme.js'
import {
  resolveNewPageWriteContext,
  resolveSpaceWriteGate,
  type NewPageGateDeps,
} from './drafts.js'

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
 *
 * Write path (Stage 4): `PUT`/`DELETE` on both paths, registered only when auth
 * is active (`access`, `canWrite`, `getUserProvider` set). They sit behind the
 * session gate (the public exemption in `app.ts` covers GET only), so a
 * read-only API token is turned away there with 403. A write commits
 * `_meta/theme.yaml` on `main` with the caller's OWN provider token after the
 * push-right check — never through the service registry, which stays the read
 * path. Validation is strict: parse errors, cross-token rules and contrast
 * below threshold are each a 422 and nothing is committed.
 *
 * User layer (Stage 6): `resolved` appends the session user's personal theme
 * (`user_settings`) last, so it wins over instance and space. Its own routes
 * live in `me-theme.ts`.
 *
 * Brand (Stage 8): `resolved` carries `brand` (name and file URLs) so the layout
 * needs no second call; the files themselves are served by `brand.ts`.
 */

export interface ThemeDeps extends InstanceThemeDeps {
  /** Configured spaces (`F451_SPACES`); unset → no space layer, every space route answers 404. */
  spaces?: readonly SpaceConfig[]
  /** Read-access check, set only when auth is active; unset → every configured space is readable
   *  (same convention as the other space read routes). */
  access?: SpaceAccess
  /** Push-right probe (`auth/permissions.ts#canWriteSpace`); with `getUserProvider` and
   *  `access` it enables the write routes. */
  canWrite?: NewPageGateDeps['canWrite']
  /** Provider bound to the caller's linked account (`drafts/user-provider.ts`). */
  getUserProvider?: NewPageGateDeps['getUserProvider']
  /** Database for the user layer (Stage 6, `user_settings`); unset → `resolved` has no user layer. */
  db?: Db
}

const tokenMapSchema = { type: 'object', additionalProperties: { type: 'string' } } as const

export const problemSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    token: { type: 'string' },
    path: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['code', 'path', 'message'],
} as const

export const themeFileSchema = {
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
        // `null` = no brand anywhere in the chain, the f451 mark applies (addendum §5).
        brand: {
          type: ['object', 'null'],
          properties: {
            name: { type: ['string', 'null'] },
            logoUrl: { type: ['string', 'null'] },
            faviconUrl: { type: ['string', 'null'] },
          },
          required: ['name', 'logoUrl', 'faviconUrl'],
        },
        layers: { type: 'array', items: { type: 'string' } },
        // Building-block switches that differ from Editorial, as `data-<name>` for `<html>` (structure spec 1).
        attributes: { type: 'object', additionalProperties: { type: 'string' } },
        // Every switch with its resolved value, defaults included — the server components read the
        // frame switches from here (structure spec 2).
        switches: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['css', 'origin', 'brand', 'layers', 'attributes', 'switches'],
    },
  },
} as const

function themeBody<O extends 'instance' | 'space'>(theme: ParsedTheme | null, origin: O) {
  if (!theme) return { file: null, layer: null, warnings: [], errors: [], origin }
  return { file: theme.file, layer: theme.layer, warnings: theme.warnings, errors: theme.errors, origin }
}

// --- Write path (Stage 4) -------------------------------------------------

export const forbiddenSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, action: { type: 'string' } },
  required: ['error'],
} as const

/** A token a rule looked at, with its resolved value and the layer it comes from. */
const ruleTokenSchema = {
  type: 'object',
  properties: {
    token: { type: 'string' },
    value: { type: 'string' },
    source: { type: 'string' },
    template: { type: 'string' },
  },
  required: ['token', 'value', 'source'],
} as const

const ruleViolationSchema = {
  type: 'object',
  properties: {
    rule: { type: 'string' },
    message: { type: 'string' },
    tokens: { type: 'array', items: ruleTokenSchema },
  },
  required: ['rule', 'message', 'tokens'],
} as const

export const contrastFindingSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    role: { type: 'string' },
    pair: {
      type: 'object',
      properties: {
        rolle: { type: 'string' },
        vorn: { type: 'string' },
        hinten: { type: 'string' },
        was: { type: 'string' },
      },
    },
    ratio: { type: 'number' },
    threshold: { type: 'number' },
    belowThreshold: { type: 'boolean' },
    belowAA: { type: 'boolean' },
  },
  required: ['mode', 'role', 'pair', 'ratio', 'threshold', 'belowThreshold', 'belowAA'],
} as const

/** 422: exactly one of `errors` (file), `rules` (resolved chain) or `contrast` is set. */
export const invalidSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['invalid', 'contrast'] },
    errors: { type: 'array', items: problemSchema },
    rules: { type: 'array', items: ruleViolationSchema },
    contrast: { type: 'array', items: contrastFindingSchema },
  },
  required: ['status'],
} as const

const writeErrorResponses = {
  403: forbiddenSchema,
  404: errorSchema,
  409: errorSchema,
  422: invalidSchema,
  502: errorSchema,
} as const

// No `body` schema on purpose (precedent `drafts.ts#saveDiagramSchema`): an AJV
// rejection would answer in Fastify's own error shape instead of the 422 below,
// and `parseThemeFile` already checks every key of the body. An unknown
// top-level key must reach it, too — the write rejects it (July spec "Grenzfälle").
const putThemeSchema = {
  tags: ['theme'],
  response: { 200: themeResponseSchema('instance'), ...writeErrorResponses },
} as const

const putSpaceThemeSchema = {
  tags: ['theme'],
  params: spaceThemeSchema.params,
  response: { 200: themeResponseSchema('space'), ...writeErrorResponses },
} as const

const deleteResponses = {
  204: { type: 'null', description: 'The theme file was removed; the layer inherits again.' },
  403: forbiddenSchema,
  404: errorSchema,
  409: errorSchema,
  502: errorSchema,
} as const

const deleteThemeSchema = { tags: ['theme'], response: deleteResponses } as const
const deleteSpaceThemeSchema = { tags: ['theme'], params: spaceThemeSchema.params, response: deleteResponses } as const

/** Upper bound of a theme file (July spec "Validierung und Sicherheit": file ≤ 32 KiB). */
export const THEME_BODY_LIMIT = 32 * 1024

/** Theme files are read from and written to the published state. */
const THEME_BRANCH = 'main'

export type WriteTarget = { space: SpaceConfig; provider: GitProvider }
export type GateFailure = { ok: false; status: number; body: unknown }

export type InvalidBody =
  | { status: 'invalid'; errors: ParsedTheme['errors'] }
  | { status: 'invalid'; rules: ReturnType<typeof describeViolation>[] }
  | { status: 'contrast'; contrast: ReturnType<typeof checkContrast> }

/** The 422 of a write whose `use` names no template of the reachable libraries. */
export function useUnknown(use: string): InvalidBody {
  return {
    status: 'invalid',
    errors: [{ code: 'use_unknown', path: 'use', message: `"${use}" names no template in the library` }],
  }
}

/** A violation with each token's resolved value and layer, so an inherited token is named as such. */
export function describeViolation(resolved: ResolvedTheme, violation: RuleViolation) {
  const values = resolved.base as Record<string, string>
  const origins = resolved.origin.base as Record<string, Origin>
  return {
    rule: violation.rule,
    message: violation.message,
    tokens: violation.tokens.map((token) => ({
      token,
      value: values[token] ?? '',
      ...(origins[token] ?? { source: 'default' as const }),
    })),
  }
}

/** Provider failures of a write: stale sha → 409, provider 403 (e.g. archived repo) → 403, rest → 502. */
export function providerFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ConflictError) {
    return reply
      .code(409)
      .send({ status: 'conflict', reason: 'The theme file changed in the meantime — reload and try again.' })
  }
  if (err instanceof ProviderError && err.status === 403) {
    return reply.code(403).send({ error: 'The linked account may not write the theme of this repository.' })
  }
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `Provider error: ${message}` })
}

/** The gate dependencies of the write routes; `null` without auth (no writes then). */
export function themeWriteGateDeps(deps: ThemeDeps): NewPageGateDeps | null {
  if (!deps.access || !deps.canWrite || !deps.getUserProvider) return null
  return {
    spaces: deps.spaces ?? [],
    access: deps.access,
    canWrite: deps.canWrite,
    getUserProvider: deps.getUserProvider,
  }
}

/** Instance repo: 404 without `F451_INSTANCE_CONFIG`, then the same account/push-right chain as a space. */
export async function instanceWriteTarget(
  deps: ThemeDeps,
  gateDeps: NewPageGateDeps,
  userId: string,
): Promise<({ ok: true } & WriteTarget) | GateFailure> {
  const cfg = deps.instanceConfig
  if (!cfg) {
    return { ok: false, status: 404, body: { status: 'not_found', reason: 'No instance repository is configured.' } }
  }
  const space = instancePseudoSpace(cfg)
  const gate = await resolveSpaceWriteGate(gateDeps, userId, space)
  if (!gate.ok) return gate
  return { ok: true, space, provider: gate.provider }
}

export interface ValidateThemeOptions {
  /** Validating a library template of this slug: no `use` allowed (`template_no_nesting`),
   *  the layer carries the template's origin mark. */
  asTemplate?: string
  /** The library a `use` is looked up in; only called when the file names one. */
  library?: () => Promise<LibraryEntry[]>
}

/**
 * Strict check of a theme file against the chain as it will be after the write.
 * Order: file (grammar, locked/unknown tokens, unknown keys, `use` known) → cross-token
 * rules → contrast below the instance thresholds. The first failing stage answers.
 * `inherited` is the chain below, already with its templates expanded.
 */
export async function validateThemeWrite(
  deps: ThemeDeps,
  body: unknown,
  source: 'instance' | 'space',
  inherited: readonly ThemeLayer[],
  opts: ValidateThemeOptions,
  log: Parameters<typeof loadContrastThresholds>[1],
): Promise<{ ok: true; parsed: ParsedTheme } | { ok: false; body: InvalidBody }> {
  const parsed = parseThemeFile(body, source, {
    allowUse: opts.asTemplate === undefined,
    allowFavicon: source === 'instance',
  })
  // Reading ignores an unknown top-level key with a warning; writing rejects it
  // (July spec "Grenzfälle": `thresholds` in a theme.yaml).
  const errors = [...parsed.errors, ...parsed.warnings.filter((w) => w.code === 'key_unknown')]
  if (errors.length > 0) return { ok: false, body: { status: 'invalid', errors } }

  let own: ThemeLayer[]
  if (opts.asTemplate !== undefined) {
    own = [{ ...parsed.layer, template: opts.asTemplate }]
  } else if (parsed.file.use) {
    // Unknown slug: an error when saving, a warning when reading (addendum §3).
    const library = opts.library ? await opts.library() : []
    const entry = findTemplate(parsed.file.use, source, library)
    if (!entry) return { ok: false, body: useUnknown(parsed.file.use) }
    own = [templateLayer(entry, source), parsed.layer]
  } else {
    own = [parsed.layer]
  }

  const resolved = resolveTheme([...inherited, ...own])
  const violations = checkRules(resolved)
  if (violations.length > 0) {
    return { ok: false, body: { status: 'invalid', rules: violations.map((v) => describeViolation(resolved, v)) } }
  }

  const thresholds = await loadContrastThresholds(deps, log)
  const contrast = checkContrast(resolved, thresholds).filter((f) => f.belowThreshold)
  if (contrast.length > 0) return { ok: false, body: { status: 'contrast', contrast } }

  return { ok: true, parsed }
}

/** Writes the normalised file on `main` with the caller's provider; `null` on success. */
export async function commitThemeFile(
  target: WriteTarget,
  path: string,
  file: ParsedTheme['file'],
  message: string,
  reply: FastifyReply,
): Promise<FastifyReply | null> {
  // An existing file's sha makes the write an update instead of a colliding create.
  let sha: string | undefined
  try {
    sha = (await target.provider.readFile(target.space.repoRef, path, THEME_BRANCH)).sha
  } catch (err) {
    if (!(err instanceof NotFoundError)) return providerFailure(reply, err)
  }
  try {
    await target.provider.writeFile(target.space.repoRef, path, stringifyYaml(file), {
      branch: THEME_BRANCH,
      message,
      sha,
    })
  } catch (err) {
    return providerFailure(reply, err)
  }
  return null
}

/** Removes the file on `main` with the caller's provider; 404 when there is none, `null` on success. */
export async function removeThemeFile(
  target: WriteTarget,
  path: string,
  message: string,
  reply: FastifyReply,
): Promise<FastifyReply | null> {
  const missing = () => reply.code(404).send({ status: 'not_found', reason: 'There is no theme file to remove.' })
  let sha: string
  try {
    sha = (await target.provider.readFile(target.space.repoRef, path, THEME_BRANCH)).sha
  } catch (err) {
    return err instanceof NotFoundError ? missing() : providerFailure(reply, err)
  }
  try {
    await target.provider.deleteFile(target.space.repoRef, path, { branch: THEME_BRANCH, message, sha })
  } catch (err) {
    return err instanceof NotFoundError ? missing() : providerFailure(reply, err)
  }
  return null
}

function registerThemeWriteRoutes(
  instance: FastifyInstance,
  deps: ThemeDeps,
  gateDeps: NewPageGateDeps,
): void {
  const commitMessage = (parsed: ParsedTheme) => `Theme: ${parsed.file.name ?? 'update'}`

  instance.put('/api/theme', { schema: putThemeSchema, bodyLimit: THEME_BODY_LIMIT }, async (req, reply) => {
    const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
    if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)

    const checked = await validateThemeWrite(
      deps,
      req.body,
      'instance',
      [],
      { library: () => loadLibrary(deps, { kind: 'instance' }, req.log) },
      req.log,
    )
    if (!checked.ok) return reply.code(422).send(checked.body)

    const failed = await commitThemeFile(target, INSTANCE_THEME_PATH, checked.parsed.file, commitMessage(checked.parsed), reply)
    if (failed) return failed
    invalidateInstanceTheme()
    return reply.code(200).send(themeBody(checked.parsed, 'instance' as const))
  })

  instance.delete('/api/theme', { schema: deleteThemeSchema }, async (req, reply) => {
    const target = await instanceWriteTarget(deps, gateDeps, req.user!.id)
    if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)

    const failed = await removeThemeFile(target, INSTANCE_THEME_PATH, 'Theme: remove', reply)
    if (failed) return failed
    invalidateInstanceTheme()
    return reply.code(204).send()
  })

  instance.put<{ Params: { space: string } }>(
    '/api/spaces/:space/theme',
    { schema: putSpaceThemeSchema, bodyLimit: THEME_BODY_LIMIT },
    async (req, reply) => {
      // Unknown/unreadable space → 404, no linked account / no push right → 403.
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)

      const inherited = await layersOf(deps, await loadInstanceTheme(deps, req.log), { kind: 'instance' }, req.log)
      const space = target.space
      const checked = await validateThemeWrite(
        deps,
        req.body,
        'space',
        inherited,
        { library: () => loadLibrary(deps, { kind: 'space', space }, req.log) },
        req.log,
      )
      if (!checked.ok) return reply.code(422).send(checked.body)

      const failed = await commitThemeFile(target, SPACE_THEME_PATH, checked.parsed.file, commitMessage(checked.parsed), reply)
      if (failed) return failed
      invalidateSpaceTheme(target.space.id)
      return reply.code(200).send(themeBody(checked.parsed, 'space' as const))
    },
  )

  instance.delete<{ Params: { space: string } }>(
    '/api/spaces/:space/theme',
    { schema: deleteSpaceThemeSchema },
    async (req, reply) => {
      const target = await resolveNewPageWriteContext(gateDeps, req.user!.id, req.params.space)
      if (!target.ok) return reply.code(target.status as 403 | 404).send(target.body)

      const failed = await removeThemeFile(target, SPACE_THEME_PATH, 'Theme: remove', reply)
      if (failed) return failed
      invalidateSpaceTheme(target.space.id)
      return reply.code(204).send()
    },
  )
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

  /**
   * The user layer (Stage 6): only for a session user — an API token
   * (`apiTokenScope` set) never gets it, the personal theme concerns browsers
   * only. Fail-soft: a database error drops the layer, reading never breaks.
   */
  async function sessionUserTheme(req: Pick<FastifyRequest, 'user' | 'apiTokenScope' | 'log'>) {
    if (!deps.db || !req.user || req.apiTokenScope != null) return null
    try {
      return await loadUserTheme(deps.db, req.user.id)
    } catch (err) {
      req.log.warn({ err }, 'user theme: unreadable — layer skipped (fail-soft)')
      return null
    }
  }

  /**
   * The brand for the layout (addendum §5), with URLs as the browser reaches them
   * through the web proxy. An inherited instance logo is named by the instance URL,
   * so every space shares one cached file. `null` when nothing is set.
   */
  async function brandBody(space: SpaceConfig | null, log: FastifyRequest['log']) {
    const brand = await resolveBrand(deps, space ?? undefined, log)
    const logoUrl =
      brand.logoScope === 'space' && space
        ? `/api/spaces/${encodeURIComponent(space.id)}/brand/logo`
        : brand.logoScope === 'instance'
          ? '/api/brand/logo'
          : null
    const faviconUrl = brand.favicon ? '/api/brand/favicon' : null
    if (brand.name === null && logoUrl === null && faviconUrl === null) return null
    return { name: brand.name, logoUrl, faviconUrl }
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
        // asks for every page, and a wrong id must not break rendering.
        const instanceTheme = await loadInstanceTheme(deps, req.log)
        const space = req.query.space ? await readableSpace(req.query.space, req.user?.id ?? '') : null
        const spaceThemeParsed = space ? await spaceTheme(space, req.log) : null
        const userTheme = await sessionUserTheme(req)
        // `use` is resolved before mixing (addendum §3): a layer with a template becomes
        // [template, own]. The user layer looks templates up in the instance library.
        const layers: ThemeLayer[] = [
          ...(await layersOf(deps, instanceTheme, { kind: 'instance' }, req.log)),
          ...(space ? await layersOf(deps, spaceThemeParsed, { kind: 'space', space }, req.log) : []),
          ...(await layersOf(deps, userTheme, { kind: 'instance' }, req.log)),
        ]
        const resolved = resolveTheme(layers)
        return {
          css: toCssDeclarations(resolved),
          origin: resolved.origin,
          brand: await brandBody(space, req.log),
          // One entry per level, also when a template doubled it.
          layers: [...new Set(layers.map((l): LayerSource => l.source))],
          attributes: toAttributes(resolved),
          switches: attributeValues(resolved),
        }
      },
    )

    // Writes need a user-bound provider and the push-right probe — both exist only with auth.
    const gateDeps = themeWriteGateDeps(deps)
    if (gateDeps) registerThemeWriteRoutes(instance, deps, gateDeps)
  })
}
