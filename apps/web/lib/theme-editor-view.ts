/**
 * Small pure helpers of the settings page `/einstellungen/erscheinungsbild`
 * that sit between `lib/theme-editor.ts` (the draft logic) and the React
 * island `components/theme-editor/`: which scope the URL names, which API
 * paths belong to it, how a field splits a value, which rows carry a finding,
 * and how a rejected save reads. No React, no fetch.
 */
import type { ContrastThresholds, KontrastRolle, Mode, TokenGroup, TokenName } from '@f451/design-tokens'
import type { Assessment, EditorGroup, EditorScope } from './theme-editor.js'

// ---- Scope ------------------------------------------------------------------

/** Answer of `GET /api/theme/scopes`. */
export interface ThemeScopes {
  instance: { available: boolean; canWrite: boolean }
  spaces: { id: string; name: string; canWrite: boolean }[]
}

export type ScopeKey = { kind: 'instance' } | { kind: 'space'; id: string }

/** The `?scope=` value of a scope: `instance` or `space:<id>`. */
export function scopeParam(scope: ScopeKey | EditorScope): string {
  return scope.kind === 'instance' ? 'instance' : `space:${scope.id}`
}

/**
 * The scope the page opens: the one `?scope=` names if the caller may see it,
 * else the instance when one is configured, else the first readable space.
 * `null` when there is nothing to open at all.
 */
export function pickScope(param: string | string[] | undefined, scopes: ThemeScopes): ScopeKey | null {
  const raw = Array.isArray(param) ? param[0] : param
  if (raw === 'instance' && scopes.instance.available) return { kind: 'instance' }
  if (raw?.startsWith('space:')) {
    const id = raw.slice('space:'.length)
    if (scopes.spaces.some((s) => s.id === id)) return { kind: 'space', id }
  }
  if (scopes.instance.available) return { kind: 'instance' }
  const first = scopes.spaces[0]
  return first ? { kind: 'space', id: first.id } : null
}

/** `GET` path of the editor data for a scope. */
export function editorApiPath(scope: ScopeKey | EditorScope): string {
  return scope.kind === 'instance'
    ? '/api/theme/editor?scope=instance'
    : `/api/theme/editor?scope=space&space=${encodeURIComponent(scope.id)}`
}

/** `PUT`/`DELETE` path of a scope's theme file. */
export function themeApiPath(scope: ScopeKey | EditorScope): string {
  return scope.kind === 'instance' ? '/api/theme' : `/api/spaces/${encodeURIComponent(scope.id)}/theme`
}

// ---- Fields -----------------------------------------------------------------

/**
 * `<input type="color">` understands `#rrggbb` only. Any other notation gets
 * no picker — a picker that shows an unreadable value as black would misstate
 * the value; the text field next to it edits every notation.
 */
export function pickerValue(value: string): string | null {
  const v = value.trim()
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null
}

/**
 * Splits a length into amount and unit for the number + unit field. A bare
 * `0` gets the first allowed unit. `null` when the value is no plain
 * dimension in one of `units` — the row then falls back to a text field.
 */
export function splitLength(value: string, units: readonly string[]): { amount: string; unit: string } | null {
  const v = value.trim()
  if (v === '0' && units[0]) return { amount: '0', unit: units[0] }
  const m = /^(-?\d*\.?\d+)([a-z]+)$/.exec(v)
  if (!m || !units.includes(m[2]!)) return null
  return { amount: m[1]!, unit: m[2]! }
}

export function joinLength(amount: string, unit: string): string {
  return `${amount.trim()}${unit}`
}

const THRESHOLD_FIELD: Record<KontrastRolle, keyof ContrastThresholds> = {
  Lesetext: 'readingText',
  'kurze Schrift': 'shortText',
  'nicht-textliche Zeichen': 'nonText',
  'beiläufige Beschriftung': 'incidental',
}

/** The thresholds field of a contrast role — also the i18n key of its name. */
export function thresholdField(role: KontrastRolle): keyof ContrastThresholds {
  return THRESHOLD_FIELD[role]
}

// ---- Rows with findings -----------------------------------------------------

export interface TokenStates {
  /** tokens with an error finding, a rule violation or a parse error */
  errors: Set<string>
  /** tokens with a warning finding (and no error) */
  warnings: Set<string>
}

export function tokenStates(a: Pick<Assessment, 'findings' | 'rules' | 'problems'>): TokenStates {
  const errors = new Set<string>()
  const warnings = new Set<string>()
  for (const f of a.findings) if (f.state === 'error') errors.add(f.token)
  for (const r of a.rules) for (const t of r.tokens) errors.add(t)
  for (const p of a.problems) if (p.token) errors.add(p.token)
  for (const f of a.findings) if (f.state === 'warning' && !errors.has(f.token)) warnings.add(f.token)
  return { errors, warnings }
}

export interface JumpTarget {
  token: TokenName
  group: TokenGroup
}

/** First row (in catalog order) with an error and with a warning — the header's jump links. */
export function firstRows(groups: EditorGroup[], states: TokenStates): { error: JumpTarget | null; warning: JumpTarget | null } {
  let error: JumpTarget | null = null
  let warning: JumpTarget | null = null
  for (const g of groups) {
    for (const row of g.rows) {
      if (!error && states.errors.has(row.name)) error = { token: row.name, group: g.group }
      if (!warning && states.warnings.has(row.name)) warning = { token: row.name, group: g.group }
    }
  }
  return { error, warning }
}

/** DOM id of a token row — target of the jump links. */
export function rowId(token: string): string {
  return `te-row-${token.replace(/^--/, '')}`
}

// ---- Save and remove --------------------------------------------------------

export interface ServerContrastItem {
  what: string
  mode: Mode
  ratio: number
  threshold: number
}

export type SaveFailure =
  | { kind: 'invalid'; messages: string[] }
  | { kind: 'contrast'; items: ServerContrastItem[] }
  | { kind: 'forbidden' }
  | { kind: 'conflict' }
  | { kind: 'notFound' }
  | { kind: 'error' }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const messagesOf = (list: unknown): string[] =>
  Array.isArray(list) ? list.flatMap((e) => (isRecord(e) && typeof e.message === 'string' ? [e.message] : [])) : []

/**
 * Reads a failed `PUT`/`DELETE` of a theme file: `422 { status: 'invalid',
 * errors | rules }`, `422 { status: 'contrast', contrast }`, 403, 404, 409;
 * everything else (502, network, unknown shape) is a plain error.
 */
export function describeSaveFailure(status: number, body: unknown): SaveFailure {
  if (status === 403) return { kind: 'forbidden' }
  if (status === 404) return { kind: 'notFound' }
  if (status === 409) return { kind: 'conflict' }
  if (status === 422 && isRecord(body)) {
    if (body.status === 'invalid') {
      return { kind: 'invalid', messages: [...messagesOf(body.errors), ...messagesOf(body.rules)] }
    }
    if (body.status === 'contrast' && Array.isArray(body.contrast)) {
      const items = body.contrast.flatMap((f): ServerContrastItem[] => {
        if (!isRecord(f) || !isRecord(f.pair)) return []
        const { mode, ratio, threshold } = f
        if ((mode !== 'light' && mode !== 'dark') || typeof ratio !== 'number' || typeof threshold !== 'number') return []
        return [{ what: String(f.pair.was ?? ''), mode, ratio, threshold }]
      })
      return { kind: 'contrast', items }
    }
  }
  return { kind: 'error' }
}
