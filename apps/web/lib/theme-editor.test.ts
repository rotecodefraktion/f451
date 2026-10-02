import {
  AA_THRESHOLDS,
  DEFAULT_THRESHOLDS,
  catalog,
  checkContrast,
  formulaToCss,
  resolveTheme,
  tokenNames,
  tokens,
  type ThemeFile,
  type ThemeLayer,
} from '@f451/design-tokens'
import { describe, expect, it } from 'vitest'
import {
  assess,
  buildGroups,
  fieldCheck,
  fieldKindFor,
  groupOpenDefaults,
  isEmpty,
  resetGroup,
  setValue,
  type EditorData,
  type EditorRow,
} from './theme-editor.js'

/**
 * A space scope over an instance layer that darkens the light accent. The
 * darker red keeps every accent pair above AA, so the default theme's known
 * shortfalls stay the only ones.
 */
const INSTANCE_ACCENT = '#9a2b16'
const instanceLayer: ThemeLayer = { source: 'instance', light: { '--color-accent': INSTANCE_ACCENT } }

function editorData(): EditorData {
  const below = resolveTheme([instanceLayer])
  return {
    scope: { kind: 'space', id: 's1', name: 'Space' },
    canWrite: true,
    file: null,
    problems: [],
    belowLayers: [instanceLayer],
    below,
    resolved: below,
    thresholds: DEFAULT_THRESHOLDS,
    defaults: DEFAULT_THRESHOLDS,
    aa: AA_THRESHOLDS,
    thresholdsSource: 'default',
    note: null,
    findings: checkContrast(below),
    rules: [],
  }
}

const row = (draft: ThemeFile, name: string): EditorRow =>
  buildGroups(editorData(), draft)
    .flatMap((g) => g.rows)
    .find((r) => r.name === name)!

describe('buildGroups', () => {
  it('lists every catalog token once, groups in catalog order', () => {
    const groups = buildGroups(editorData(), {})
    expect(groups.flatMap((g) => g.rows.map((r) => r.name))).toEqual(
      [...tokenNames].sort((a, b) => groups.findIndex((g) => g.group === catalog[a].group) - groups.findIndex((g) => g.group === catalog[b].group)),
    )
    expect(groups[0]!.group).toBe('Grundfarben')
  })

  it('marks origins default, inherited and set', () => {
    const accent = row({ light: { 'color-bg': '#ffffff' } }, '--color-accent')
    expect(accent.kind).toBe('color')
    expect(accent.values.light).toEqual({ effective: INSTANCE_ACCENT, origin: 'inherited', below: INSTANCE_ACCENT })
    expect(accent.values.dark).toMatchObject({ effective: tokens.dark['--color-accent'], origin: 'default' })
    expect(accent.values.base).toBeUndefined()

    const bg = row({ light: { 'color-bg': '#ffffff' } }, '--color-bg')
    expect(bg.values.light).toEqual({ effective: '#ffffff', origin: 'set', set: '#ffffff', below: tokens.light['--color-bg'] })
  })

  it('setValue then null restores inheritance', () => {
    const set = setValue({}, '--color-accent', 'light', '#123456')
    expect(set).toEqual({ light: { 'color-accent': '#123456' } })
    expect(row(set, '--color-accent').values.light).toMatchObject({ effective: '#123456', origin: 'set', set: '#123456' })

    const cleared = setValue(set, 'color-accent', 'light', null)
    expect(cleared).toEqual({})
    expect(isEmpty(cleared)).toBe(true)
    expect(row(cleared, '--color-accent').values.light).toMatchObject({ effective: INSTANCE_ACCENT, origin: 'inherited' })
    // never mutates
    expect(set).toEqual({ light: { 'color-accent': '#123456' } })
  })

  it('shows derived rows with formula and computed value', () => {
    const focus = row({}, '--color-focus')
    expect(focus.kind).toBe('derived')
    expect(focus.formula).toBe(formulaToCss(tokens.derived['--color-focus']))
    expect(focus.overridden).toBe(false)
    // alias of the accent — follows the inherited instance value
    expect(focus.values.light?.effective).toBe(INSTANCE_ACCENT)
    expect(row(setValue({}, 'color-focus', 'dark', '#00ff00'), '--color-focus').overridden).toBe(true)
  })

  it('gives structure rows a base value and locked rows their reason', () => {
    const measure = row({}, '--measure')
    expect(measure.kind).toBe('structure')
    expect(measure.values.base?.effective).toBe(tokens.structure['--measure'])
    const scrim = row({}, '--color-scrim')
    expect(scrim.locked).toBe(true)
    expect(scrim.lockReason).toBeTruthy()
  })

  it('counts the set values per group', () => {
    const draft: ThemeFile = { light: { 'color-accent': '#123456', 'color-bg': '#ffffff' }, dark: { 'color-accent': '#abcdef' } }
    const groups = buildGroups(editorData(), draft)
    expect(groups.find((g) => g.group === 'Grundfarben')!.setCount).toBe(3)
    expect(groups.find((g) => g.group === 'Workflow-Status')!.setCount).toBe(0)
  })
})

describe('resetGroup', () => {
  it('clears only that group', () => {
    const draft: ThemeFile = {
      name: 'Mine',
      base: { measure: '70ch' },
      light: { 'color-accent': '#123456', 'color-status-working': '#334455' },
      dark: { 'color-bg': '#000000' },
    }
    expect(resetGroup(draft, 'Grundfarben')).toEqual({
      name: 'Mine',
      base: { measure: '70ch' },
      light: { 'color-status-working': '#334455' },
    })
    expect(draft.dark).toEqual({ 'color-bg': '#000000' })
  })
})

describe('isEmpty', () => {
  it('is false with a name or a value', () => {
    expect(isEmpty({})).toBe(true)
    expect(isEmpty({ name: 'x' })).toBe(false)
    expect(isEmpty({ base: { measure: '70ch' } })).toBe(false)
  })
})

describe('fieldCheck', () => {
  it('rejects a bad length and accepts a good one', () => {
    expect(fieldCheck('--measure', '0.4rm').ok).toBe(false)
    expect(fieldCheck('measure', '90ch').ok).toBe(false)
    expect(fieldCheck('--measure', '70ch')).toEqual({ ok: true, value: '70ch' })
  })

  it('rejects unknown and locked tokens', () => {
    expect(fieldCheck('--no-such-token', '1px').ok).toBe(false)
    expect(fieldCheck('--color-scrim', '#000000').ok).toBe(false)
  })
})

describe('assess', () => {
  it('passes the default theme, keeping its known AA shortfalls as warnings', () => {
    const a = assess(editorData(), {})
    expect(a.errors).toBe(0)
    expect(a.saveBlocked).toBe(false)
    // Pinned in packages/design-tokens/test/contrast.test.ts (UNTER_AA).
    expect(a.findings.filter((f) => f.state === 'warning').map((f) => `${f.mode} ${f.what}`)).toEqual([
      'light Kommentar im Codeblock',
      'light Zeilennummern im Codeblock',
      'dark Zeilennummern im Codeblock',
    ])
    expect(a.warnings).toBe(3)
  })

  it('flags a pale accent as error and blocks saving', () => {
    const a = assess(editorData(), setValue({}, 'color-accent', 'light', '#dddddd'))
    const accent = a.findings.filter((f) => f.token === '--color-accent' && f.state === 'error')
    expect(accent.length).toBeGreaterThan(0)
    expect(accent.every((f) => f.mode === 'light')).toBe(true)
    expect(accent[0]).toMatchObject({ role: 'kurze Schrift', threshold: 3.5, aa: 4.5 })
    expect(a.saveBlocked).toBe(true)
  })

  it('blocks saving on a rule violation', () => {
    const a = assess(editorData(), setValue({}, 'weight-strong', 'base', '450'))
    expect(a.rules.map((r) => r.rule)).toEqual(['weight-gap'])
    expect(a.saveBlocked).toBe(true)
  })

  it('blocks saving on a value the parser rejects', () => {
    const a = assess(editorData(), setValue({}, 'color-accent', 'light', 'red'))
    expect(a.problems).toHaveLength(1)
    expect(a.saveBlocked).toBe(true)
  })
})

describe('helpers', () => {
  it('opens only the first group', () => {
    const open = groupOpenDefaults()
    expect(Object.entries(open).filter(([, v]) => v).map(([g]) => g)).toEqual(['Grundfarben'])
  })

  it('maps ranges to field kinds', () => {
    expect(fieldKindFor({ kind: 'hex' })).toBe('color')
    expect(fieldKindFor({ kind: 'length', units: ['ch'], min: 60, max: 80 })).toBe('length')
    expect(fieldKindFor({ kind: 'text-size' })).toBe('text')
    expect(fieldKindFor(undefined)).toBe('text')
  })
})
