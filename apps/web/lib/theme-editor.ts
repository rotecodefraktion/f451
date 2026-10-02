/**
 * Pure logic behind the settings page `/einstellungen/erscheinungsbild`
 * (July spec `2026-07-26-themefaehigkeit-design.md`, chapter "Bedienung").
 *
 * No React, no fetch: the page holds a draft `ThemeFile` (keys WITHOUT dashes,
 * exactly what gets saved) next to the `EditorData` the API returned for the
 * scope, and asks this module what to show. Every value, rule and contrast
 * figure comes from `@f451/design-tokens` — the same resolver and the same
 * checks the server runs on save, so the page never shows numbers nobody
 * checks. The browser check is a convenience; the server decides.
 */
import {
  catalog,
  checkContrast,
  checkRules,
  checkValue,
  formulaToCss,
  loeseBezug,
  parseThemeFile,
  resolveTheme,
  tokenNames,
  tokens,
  type Bezug,
  type ContrastFinding,
  type ContrastThresholds,
  type DerivedTokenName,
  type KontrastRolle,
  type LayerSource,
  type Mode,
  type Origin,
  type ResolvedTheme,
  type RuleViolation,
  type StructureTokenName,
  type ThemeFile,
  type ThemeLayer,
  type ThemeProblem,
  type TokenGroup,
  type TokenLevel,
  type TokenMeta,
  type TokenName,
  type TokenRange,
  type ValueCheck,
} from '@f451/design-tokens'

// ---- Data from the API ------------------------------------------------------

/** `user` is "Meine Einstellungen" — the caller's personal theme (addendum §2/§7). */
export type EditorScope = { kind: 'user' } | { kind: 'instance' } | { kind: 'space'; id: string; name: string }

/** The API's answer for one scope (built by the theme route). */
export interface EditorData {
  scope: EditorScope
  canWrite: boolean
  /** the scope's own file, keys without dashes */
  file: ThemeFile | null
  problems: ThemeProblem[]
  /** layers under this scope: [] for the instance, [instance] for a space and for the user scope */
  belowLayers: ThemeLayer[]
  /** what the "Vorgabe" column measures against */
  below: ResolvedTheme
  resolved: ResolvedTheme
  thresholds: ContrastThresholds
  defaults: ContrastThresholds
  aa: ContrastThresholds
  thresholdsSource: 'default' | 'instance'
  note: string | null
  findings: ContrastFinding[]
  rules: RuleViolation[]
}

/** One entry of `GET /api/theme/library` / `GET /api/spaces/:space/theme/library` (addendum §3). */
export type LibraryOrigin = 'builtin' | 'instance' | 'space'

export interface LibraryEntry {
  slug: string
  name: string
  origin: LibraryOrigin
  file: ThemeFile
}

// ---- Templates (`use`, addendum §3) -------------------------------------------

const INSTANCE_PREFIX = 'instance/'

/**
 * The template a `use` reference names, seen from the editor's scope — the
 * same lookup as the API's `theme/library.ts#findTemplate`:
 * `instance/<slug>` → instance library (built-in or instance repo);
 * `<slug>` → the scope's own library (instance scope: instance library, space
 * scope: the space's templates; the user scope has no own library).
 */
export function findTemplate(
  use: string,
  scope: EditorScope['kind'],
  templates: readonly LibraryEntry[],
): LibraryEntry | undefined {
  const instanceRef = use.startsWith(INSTANCE_PREFIX)
  const slug = instanceRef ? use.slice(INSTANCE_PREFIX.length) : use
  const namespace = instanceRef || scope === 'instance' ? 'instance' : scope === 'space' ? 'space' : null
  if (namespace === null) return undefined
  return templates.find((e) => e.slug === slug && (namespace === 'space' ? e.origin === 'space' : e.origin !== 'space'))
}

/** The library entry behind an origin mark: a space layer's template is a space template, any other an instance one. */
function templateEntryFor(slug: string, source: LayerSource, templates: readonly LibraryEntry[]): LibraryEntry | undefined {
  return templates.find((e) => e.slug === slug && (source === 'space' ? e.origin === 'space' : e.origin !== 'space'))
}

/** A template as the layer under the one that uses it: same source, origin mark `template: <slug>` (as the API builds it). */
function templateLayer(entry: LibraryEntry, source: LayerSource): ThemeLayer {
  const { layer } = parseThemeFile(entry.file, source, { allowUse: false, allowFavicon: true })
  return { ...layer, template: entry.slug }
}

export interface DraftChain {
  parsed: ReturnType<typeof parseThemeFile>
  /** the template the draft's `use` names, when the library knows it */
  template: LibraryEntry | null
  /** the draft's `use` when the library does not know it — the layer then applies without a template */
  missingUse: string | null
  /** `[...belowLayers, template?, own]` */
  layers: ThemeLayer[]
  /** what applies without the draft's own values: the layers below plus the template */
  below: ResolvedTheme
}

/**
 * The draft's layer chain with its `use` expanded the way the server expands
 * it before mixing: `[...belowLayers, template, own]`. `belowLayers` from the
 * API are already expanded; only the draft's own `use` is resolved here, so a
 * change of the template select shows at once. An unknown reference adds no
 * layer (the server's read behaviour) and is reported in `missingUse`.
 */
export function draftChain(data: EditorData, draft: ThemeFile, templates: readonly LibraryEntry[] = []): DraftChain {
  const source = layerSource(data.scope)
  const parsed = parseThemeFile(draft, source)
  const use = draft.use
  const entry = use ? findTemplate(use, data.scope.kind, templates) : undefined
  const below = entry ? [...data.belowLayers, templateLayer(entry, source)] : data.belowLayers
  return {
    parsed,
    template: entry ?? null,
    missingUse: use && !entry ? use : null,
    layers: [...below, parsed.layer],
    below: entry ? resolveTheme(below) : data.below,
  }
}

// ---- Rows and groups --------------------------------------------------------

export type ValueMode = Mode | 'base'
export type ValueOrigin = 'default' | 'inherited' | 'set'
export type RowKind = 'color' | 'shadow' | 'structure' | 'derived' | 'switch'

export interface RowValue {
  /** what applies with the draft: own value, else inherited, else default (derived: computed) */
  effective: string
  /** "Vorgabe · Instanz · hier gesetzt" */
  origin: ValueOrigin
  /** the draft's own raw value — present exactly when origin is 'set' (may be invalid, see fieldCheck) */
  set?: string
  /** what applies without the draft's value — the row falls back to this on reset */
  below: string
  /** slug of the template the effective value comes from (origin stays 'inherited'); absent otherwise */
  template?: string
  /** that template's name from the library; the slug when the library does not know it */
  templateName?: string
}

export interface EditorRow {
  name: TokenName
  role: string
  level: TokenLevel
  group: TokenGroup
  range?: TokenRange
  locked: boolean
  lockReason?: string
  kind: RowKind
  /** theme and derived rows: light + dark; structure rows: base; switch rows: none */
  values: Partial<Record<ValueMode, RowValue>>
  /** derived rows only: the CSS of the formula */
  formula?: string
  /** derived rows only: the draft sets an explicit value in light or dark */
  overridden?: boolean
}

export interface EditorGroup {
  group: TokenGroup
  rows: EditorRow[]
  /** number of values the draft sets in this group (light and dark count separately) */
  setCount: number
}

const SECTIONS: readonly ValueMode[] = ['base', 'light', 'dark']

/** Groups in catalog order — the catalog is ordered like the mockup. */
const GROUPS: readonly TokenGroup[] = [...new Set(tokenNames.map((n) => catalog[n].group as TokenGroup))]

const fileKey = (name: string): string => (name.startsWith('--') ? name.slice(2) : name)

/** Catalog name for a file key or a catalog name; undefined when unknown. */
function catalogName(name: string): TokenName | undefined {
  const n = name.startsWith('--') ? name : `--${name}`
  return Object.prototype.hasOwnProperty.call(catalog, n) ? (n as TokenName) : undefined
}

function layerSource(scope: EditorScope): LayerSource {
  return scope.kind
}

function kindOf(name: TokenName): RowKind {
  const meta = catalog[name] as TokenMeta
  switch (meta.level) {
    case 'theme':
      return meta.group === 'Schatten' ? 'shadow' : 'color'
    case 'derived':
      return 'derived'
    case 'structure':
      return 'structure'
    case 'switch':
      return 'switch'
  }
}

/**
 * The value a token has in a resolved set. A derived colour nobody set is
 * computed from its formula with the resolved inputs — the same mix the
 * browser performs; the veil keeps its CSS form (it carries an opacity).
 */
function effectiveOf(resolved: ResolvedTheme, mode: ValueMode, name: TokenName): string {
  if (mode === 'base') return resolved.base[name as StructureTokenName] ?? ''
  const explicit = (resolved[mode] as Record<string, string>)[name]
  if (explicit !== undefined) return explicit
  const formula = tokens.derived[name as DerivedTokenName]
  if (!formula) return ''
  return formula.kind === 'veil' ? formulaToCss(formula) : loeseBezug(mode, `~${name}` as Bezug, resolved[mode])
}

function originOf(resolved: ResolvedTheme, mode: ValueMode, name: TokenName): Origin | undefined {
  const origins = (mode === 'base' ? resolved.origin.base : resolved.origin[mode]) as Record<string, Origin>
  return origins[name]
}

interface RowContext {
  draft: ThemeFile
  resolved: ResolvedTheme
  below: ResolvedTheme
  templates: readonly LibraryEntry[]
  /** the template the draft's own `use` picked — named directly, so `instance/fokus`
   *  in a space is not confused with the space's own `fokus` */
  draftTemplate: LibraryEntry | null
  ownSource: LayerSource
}

function rowValue(ctx: RowContext, mode: ValueMode, name: TokenName): RowValue {
  const own = ctx.draft[mode]?.[fileKey(name)]
  const origin = originOf(ctx.resolved, mode, name)
  const value: RowValue = {
    effective: effectiveOf(ctx.resolved, mode, name),
    origin: own !== undefined ? 'set' : (origin?.source ?? 'default') === 'default' ? 'default' : 'inherited',
    below: effectiveOf(ctx.below, mode, name),
  }
  if (own !== undefined) value.set = own
  else if (origin?.template !== undefined) {
    value.template = origin.template
    const picked =
      ctx.draftTemplate && origin.source === ctx.ownSource && ctx.draftTemplate.slug === origin.template
        ? ctx.draftTemplate
        : templateEntryFor(origin.template, origin.source, ctx.templates)
    value.templateName = picked?.name ?? origin.template
  }
  return value
}

function buildRow(ctx: RowContext, name: TokenName): EditorRow {
  const meta = catalog[name] as TokenMeta
  const kind = kindOf(name)
  const modes: ValueMode[] = kind === 'switch' ? [] : kind === 'structure' ? ['base'] : ['light', 'dark']
  const row: EditorRow = {
    name,
    role: meta.role,
    level: meta.level,
    group: meta.group,
    locked: !meta.settable,
    kind,
    values: {},
  }
  if (meta.range) row.range = meta.range
  if (!meta.settable) row.lockReason = meta.lockReason
  for (const mode of modes) row.values[mode] = rowValue(ctx, mode, name)
  if (kind === 'derived') {
    row.formula = formulaToCss(tokens.derived[name as DerivedTokenName])
    row.overridden = row.values.light?.origin === 'set' || row.values.dark?.origin === 'set'
  }
  return row
}

/** The draft resolved on top of the layers below the scope and its own template. */
function resolveDraft(data: EditorData, draft: ThemeFile, templates: readonly LibraryEntry[]) {
  const chain = draftChain(data, draft, templates)
  return { chain, parsed: chain.parsed, resolved: resolveTheme(chain.layers) }
}

/** `templates` is the scope's library — needed to expand the draft's `use` and to name template marks. */
export function buildGroups(data: EditorData, draft: ThemeFile, templates: readonly LibraryEntry[] = []): EditorGroup[] {
  const { chain, resolved } = resolveDraft(data, draft, templates)
  const ctx: RowContext = {
    draft,
    resolved,
    below: chain.below,
    templates,
    draftTemplate: chain.template,
    ownSource: layerSource(data.scope),
  }
  const groups = new Map<TokenGroup, EditorGroup>(GROUPS.map((g) => [g, { group: g, rows: [], setCount: 0 }]))
  for (const name of tokenNames) {
    const row = buildRow(ctx, name)
    const group = groups.get(row.group)!
    group.rows.push(row)
    group.setCount += Object.values(row.values).filter((v) => v?.origin === 'set').length
  }
  return [...groups.values()]
}

/** First group open, the rest closed (spec, "Gliederung"); the page remembers changes itself. */
export function groupOpenDefaults(): Record<TokenGroup, boolean> {
  return Object.fromEntries(GROUPS.map((g, i) => [g, i === 0])) as Record<TokenGroup, boolean>
}

// ---- Editing the draft ------------------------------------------------------

/**
 * Sets (or with `null` removes) one value. Removing the key is "auf Vorgabe
 * zurücksetzen": inheritance applies again. The name may be given with or
 * without dashes; the file always gets it without. Never mutates `draft`.
 */
export function setValue(draft: ThemeFile, name: string, mode: ValueMode, value: string | null): ThemeFile {
  const key = fileKey(name)
  const section: Record<string, string> = { ...(draft[mode] ?? {}) }
  if (value === null) delete section[key]
  else section[key] = value
  const next: ThemeFile = { ...draft }
  if (Object.keys(section).length > 0) next[mode] = section
  else delete next[mode]
  return next
}

/** Sets (or with `null`/`''` removes) the draft's template reference `use`. Never mutates `draft`. */
export function setUse(draft: ThemeFile, use: string | null): ThemeFile {
  const next: ThemeFile = { ...draft }
  if (use === null || use === '') delete next.use
  else next.use = use
  return next
}

/**
 * The body of "Als Vorlage speichern": the draft's values under the given
 * name, without `use` (a template must not use another, `template_no_nesting`)
 * and without `brand` (a template carries tokens only).
 */
export function templateFile(draft: ThemeFile, name: string): ThemeFile {
  const next: ThemeFile = { ...draft, name }
  delete next.use
  delete next.brand
  return next
}

/** Removes every value of one group from all sections; unknown keys stay (the parser reports them). */
export function resetGroup(draft: ThemeFile, group: TokenGroup): ThemeFile {
  const next: ThemeFile = { ...draft }
  for (const mode of SECTIONS) {
    const section = draft[mode]
    if (!section) continue
    const kept = Object.fromEntries(
      Object.entries(section).filter(([key]) => {
        const name = catalogName(key)
        return !name || catalog[name].group !== group
      }),
    )
    if (Object.keys(kept).length > 0) next[mode] = kept
    else delete next[mode]
  }
  return next
}

/** True when the draft carries nothing at all — no values, no name, no template, no brand. */
export function isEmpty(draft: ThemeFile): boolean {
  const sectionsEmpty = SECTIONS.every((m) => Object.keys(draft[m] ?? {}).length === 0)
  return sectionsEmpty && draft.name === undefined && draft.use === undefined && draft.brand === undefined
}

// ---- Field check ------------------------------------------------------------

/** Value check on leaving a field: the catalog range through `checkValue`. Name with or without dashes. */
export function fieldCheck(name: string, raw: string): ValueCheck {
  const n = catalogName(name)
  if (!n) return { ok: false, reason: `"${fileKey(name)}" is not a known token` }
  const meta = catalog[n] as TokenMeta
  if (!meta.settable) return { ok: false, reason: `"${fileKey(name)}" is locked: ${meta.lockReason}` }
  if (!meta.range) return { ok: false, reason: `"${fileKey(name)}" has no value grammar in the catalog` }
  return checkValue(meta.range, raw)
}

export type FieldKind = 'color' | 'number' | 'length' | 'font' | 'duration' | 'easing' | 'choice' | 'text'

/** Which input a row gets. `text-size` admits a `clamp()` form and `shadow` a free list, so both are text. */
export function fieldKindFor(range: TokenRange | undefined): FieldKind {
  switch (range?.kind) {
    case 'hex':
      return 'color'
    case 'number':
      return 'number'
    case 'length':
      return 'length'
    case 'font-stack':
      return 'font'
    case 'duration':
      return 'duration'
    case 'easing':
      return 'easing'
    case 'choice':
      return 'choice'
    default:
      return 'text'
  }
}

// ---- Assessment -------------------------------------------------------------

export type FindingState = 'ok' | 'warning' | 'error'

/** One contrast pair in one mode, attached to the row of its foreground token. */
export interface RowFinding {
  /** foreground token — the row the finding is shown at */
  token: string
  mode: Mode
  state: FindingState
  ratio: number
  threshold: number
  aa: number
  role: KontrastRolle
  /** background token */
  against: string
  /** description of the pair from the pair table */
  what: string
}

export interface Assessment {
  resolved: ResolvedTheme
  findings: RowFinding[]
  rules: RuleViolation[]
  /** parse errors of the draft — values the server would reject with 422 */
  problems: ThemeProblem[]
  /** error findings + rule violations + parse errors */
  errors: number
  warnings: number
  saveBlocked: boolean
  /** the template the draft's `use` names, when the library knows it */
  template: LibraryEntry | null
  /** the draft's `use` when the library does not know it (a notice at the select, not counted as error) */
  missingUse: string | null
}

const THRESHOLD_FIELD: Record<KontrastRolle, keyof ContrastThresholds> = {
  Lesetext: 'readingText',
  'kurze Schrift': 'shortText',
  'nicht-textliche Zeichen': 'nonText',
  'beiläufige Beschriftung': 'incidental',
}

const plain = (ref: Bezug): string => ref.replace('~', '')

/**
 * `contrastBlocks` is false for the user scope: a personal theme below the
 * thresholds is saved anyway (addendum §2, the user only harms themselves), so
 * such a finding is a warning, never an error.
 */
function toRowFinding(f: ContrastFinding, aa: ContrastThresholds, contrastBlocks: boolean): RowFinding {
  return {
    token: plain(f.pair.vorn),
    mode: f.mode,
    state: f.belowThreshold && contrastBlocks ? 'error' : f.belowThreshold || f.belowAA ? 'warning' : 'ok',
    ratio: f.ratio,
    threshold: f.threshold,
    aa: aa[THRESHOLD_FIELD[f.role]],
    role: f.role,
    against: plain(f.pair.hinten),
    what: f.pair.was,
  }
}

/**
 * Live check of the draft — the same steps as the server's save check:
 * parse, resolve on top of the layers below, contrast against the scope's
 * thresholds, cross-token rules. Errors block saving, warnings never do. In
 * the user scope contrast is only ever a warning (rules and parse errors still
 * block, as on the server). The draft's `use` is expanded with `templates`
 * (the scope's library) before mixing, as the server does.
 */
export function assess(data: EditorData, draft: ThemeFile, templates: readonly LibraryEntry[] = []): Assessment {
  const { chain, parsed, resolved } = resolveDraft(data, draft, templates)
  const contrastBlocks = data.scope.kind !== 'user'
  const findings = checkContrast(resolved, data.thresholds).map((f) => toRowFinding(f, data.aa, contrastBlocks))
  const rules = checkRules(resolved)
  const errors = findings.filter((f) => f.state === 'error').length + rules.length + parsed.errors.length
  const warnings = findings.filter((f) => f.state === 'warning').length
  return {
    resolved,
    findings,
    rules,
    problems: parsed.errors,
    errors,
    warnings,
    saveBlocked: errors > 0,
    template: chain.template,
    missingUse: chain.missingUse,
  }
}
