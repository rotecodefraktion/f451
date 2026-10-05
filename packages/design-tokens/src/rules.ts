import type { StructureTokenName, TokenName } from './catalog.js'
import type { ResolvedTheme } from './theme.js'

/**
 * Cross-token rules, checked on the RESOLVED set — never on a single file
 * (`2026-10-02-theming-erweiterungen-design.md`, §4). A space file that only
 * sets `--measure-wide` must pass against the `--measure` it inherits from the
 * instance; that is why every message names both tokens and the layer each
 * value comes from.
 *
 * The three rules of the spec: the `--space-*` scale does not decrease,
 * `--weight-strong` sits at least 100 above `--weight-text`, and `--measure`
 * does not exceed `--measure-wide`. Since 1.2.6 a fourth: `--pane-controls:
 * topbar` requires `--topbar: on`.
 *
 * Values are expected to be plain `<number><unit>` after the grammar check. A
 * value this file cannot read (a `calc()` or `var()` from the defaults, or two
 * sides in different units) is left alone: the rule cannot judge it, and
 * refusing a theme for something it cannot judge would be a guess.
 */

export interface RuleViolation {
  rule: string
  tokens: TokenName[]
  message: string
}

type Measure = { n: number; unit: string }

/** `12.5rem` → 12.5 rem; `400` → 400 with an empty unit; anything else → null. */
function parseMeasure(value: string): Measure | null {
  const m = /^\s*(-?\d*\.?\d+)\s*([a-z%]*)\s*$/i.exec(value)
  return m ? { n: Number(m[1]), unit: m[2]!.toLowerCase() } : null
}

/** `--measure 68ch (instance)` or `… (space, template fokus)` — token, value, layer. */
function describe(resolved: ResolvedTheme, name: StructureTokenName): string {
  const o = resolved.origin.base[name]
  const where = o.template === undefined ? o.source : `${o.source}, template ${o.template}`
  return `${name} ${resolved.base[name]} (${where})`
}

function measureOf(resolved: ResolvedTheme, name: StructureTokenName): Measure | null {
  return parseMeasure(resolved.base[name])
}

const SPACE_STEPS = [
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  '--space-9',
  '--space-10',
  '--space-11',
] as const satisfies readonly StructureTokenName[]

function spaceScale(resolved: ResolvedTheme): RuleViolation[] {
  const out: RuleViolation[] = []
  for (let i = 1; i < SPACE_STEPS.length; i++) {
    const lower = SPACE_STEPS[i - 1]!
    const upper = SPACE_STEPS[i]!
    const a = measureOf(resolved, lower)
    const b = measureOf(resolved, upper)
    if (!a || !b || a.unit !== b.unit || b.n >= a.n) continue
    out.push({
      rule: 'space-monotonic',
      tokens: [lower, upper],
      message: `${describe(resolved, upper)} is below ${describe(resolved, lower)}; the --space-* scale must not decrease`,
    })
  }
  return out
}

function weightGap(resolved: ResolvedTheme): RuleViolation[] {
  const text = measureOf(resolved, '--weight-text')
  const strong = measureOf(resolved, '--weight-strong')
  if (!text || !strong || strong.n >= text.n + 100) return []
  return [
    {
      rule: 'weight-gap',
      tokens: ['--weight-text', '--weight-strong'],
      message: `${describe(resolved, '--weight-strong')} must be at least 100 above ${describe(resolved, '--weight-text')}`,
    },
  ]
}

function measureOrder(resolved: ResolvedTheme): RuleViolation[] {
  const measure = measureOf(resolved, '--measure')
  const wide = measureOf(resolved, '--measure-wide')
  if (!measure || !wide || measure.unit !== wide.unit || measure.n <= wide.n) return []
  return [
    {
      rule: 'measure-order',
      tokens: ['--measure', '--measure-wide'],
      message: `${describe(resolved, '--measure-wide')} is below ${describe(resolved, '--measure')}; --measure must not exceed --measure-wide`,
    },
  ]
}

/**
 * Pane switches in the top bar need a top bar; without one the panes could not
 * be opened at all. Readers fall back to `edges` (theming-struktur-2 spec).
 */
function paneControlsNeedTopbar(resolved: ResolvedTheme): RuleViolation[] {
  if (resolved.base['--pane-controls'] !== 'topbar' || resolved.base['--topbar'] === 'on') return []
  return [
    {
      rule: 'pane-controls-needs-topbar',
      tokens: ['--topbar', '--pane-controls'],
      message: `${describe(resolved, '--pane-controls')} requires --topbar on, but it is ${describe(resolved, '--topbar')}`,
    },
  ]
}

/** Cross-token rules on the resolved set; empty = ok. */
export function checkRules(resolved: ResolvedTheme): RuleViolation[] {
  return [
    ...spaceScale(resolved),
    ...weightGap(resolved),
    ...measureOrder(resolved),
    ...paneControlsNeedTopbar(resolved),
  ]
}
