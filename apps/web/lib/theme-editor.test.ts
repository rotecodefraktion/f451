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
  adoptTemplate,
  embedTemplate,
  assess,
  buildGroups,
  fieldCheck,
  fieldKindFor,
  groupOpenDefaults,
  isEmpty,
  resetGroup,
  setBrandName,
  setUse,
  setValue,
  templateFile,
  templateState,
  type EditorData,
  type EditorRow,
  type LibraryEntry,
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

  describe('user scope', () => {
    const userData = (): EditorData => ({ ...editorData(), scope: { kind: 'user' } })

    it('never blocks on contrast: a pale accent is a warning only', () => {
      const a = assess(userData(), setValue({}, 'color-accent', 'light', '#dddddd'))
      const accent = a.findings.filter((f) => f.token === '--color-accent' && f.mode === 'light' && f.state !== 'ok')
      expect(accent.length).toBeGreaterThan(0)
      expect(accent.every((f) => f.state === 'warning')).toBe(true)
      expect(a.findings.some((f) => f.state === 'error')).toBe(false)
      expect(a.errors).toBe(0)
      expect(a.warnings).toBeGreaterThan(3)
      expect(a.saveBlocked).toBe(false)
    })

    it('still blocks on a rule violation and on a parse error', () => {
      expect(assess(userData(), setValue({}, 'weight-strong', 'base', '450')).saveBlocked).toBe(true)
      expect(assess(userData(), setValue({}, 'color-accent', 'light', 'red')).saveBlocked).toBe(true)
    })

    it('resolves the draft as the user layer', () => {
      const a = assess(userData(), setValue({}, 'color-accent', 'light', '#aa3300'))
      expect(a.resolved.origin.light['--color-accent']?.source).toBe('user')
    })
  })
})

describe('templates (use)', () => {
  // A space template and an instance template of the same slug side by side:
  // `fokus` and `instance/fokus` are different references (addendum §3).
  const SPACE_FOKUS = '#7a2210'
  const INSTANCE_FOKUS = '#1d4f91'
  const library: LibraryEntry[] = [
    { slug: 'fokus', name: 'Fokus Space', origin: 'space', file: { name: 'Fokus Space', light: { 'color-accent': SPACE_FOKUS } } },
    { slug: 'fokus', name: 'Fokus Instanz', origin: 'instance', file: { light: { 'color-accent': INSTANCE_FOKUS } } },
    { slug: 'papier', name: 'Papier', origin: 'builtin', file: { dark: { 'color-accent': '#e0a080' } } },
  ]
  const accentLight = (data: EditorData, draft: ThemeFile, templates: LibraryEntry[] = library) =>
    buildGroups(data, draft, templates)
      .flatMap((g) => g.rows)
      .find((r) => r.name === '--color-accent')!.values.light!

  it('expands an own `use` from the scope library, marking the rows with the template', () => {
    const v = accentLight(editorData(), { use: 'fokus' })
    expect(v).toEqual({
      effective: SPACE_FOKUS,
      origin: 'inherited',
      below: SPACE_FOKUS,
      template: 'fokus',
      templateName: 'Fokus Space',
    })
    // what the template does not set keeps its old origin and no mark
    const dark = buildGroups(editorData(), { use: 'fokus' }, library)
      .flatMap((g) => g.rows)
      .find((r) => r.name === '--color-accent')!.values.dark!
    expect(dark).toMatchObject({ origin: 'default' })
    expect(dark.template).toBeUndefined()
  })

  it('expands `instance/<slug>` from the instance library', () => {
    expect(accentLight(editorData(), { use: 'instance/fokus' })).toMatchObject({
      effective: INSTANCE_FOKUS,
      origin: 'inherited',
      template: 'fokus',
      templateName: 'Fokus Instanz',
    })
    const a = assess(editorData(), { use: 'instance/papier' }, library)
    expect(a.template?.origin).toBe('builtin')
    expect(a.resolved.dark['--color-accent']).toBe('#e0a080')
    expect(a.resolved.origin.dark['--color-accent']).toEqual({ source: 'space', template: 'papier' })
  })

  it('lets the own values lie over the template', () => {
    const v = accentLight(editorData(), { use: 'fokus', light: { 'color-accent': '#123456' } })
    expect(v).toEqual({ effective: '#123456', origin: 'set', set: '#123456', below: SPACE_FOKUS })
  })

  it('applies an unknown `use` without a template and reports it, without blocking', () => {
    const a = assess(editorData(), { use: 'nope' }, library)
    expect(a.template).toBeNull()
    expect(a.missingUse).toBe('nope')
    expect(a.saveBlocked).toBe(false)
    expect(a.resolved.light['--color-accent']).toBe(INSTANCE_ACCENT)
    expect(accentLight(editorData(), { use: 'nope' })).toEqual({ effective: INSTANCE_ACCENT, origin: 'inherited', below: INSTANCE_ACCENT })
    // without a loaded library every reference is unknown
    expect(assess(editorData(), { use: 'fokus' }).missingUse).toBe('fokus')
    expect(assess(editorData(), {}, library).missingUse).toBeNull()
  })

  it('knows no own library in the user scope', () => {
    const userData: EditorData = { ...editorData(), scope: { kind: 'user' } }
    expect(assess(userData, { use: 'fokus' }, library).missingUse).toBe('fokus')
    const a = assess(userData, { use: 'instance/fokus' }, library)
    expect(a.template?.origin).toBe('instance')
    expect(a.resolved.origin.light['--color-accent']).toEqual({ source: 'user', template: 'fokus' })
  })

  it('looks up the instance library for the instance scope with or without prefix', () => {
    const instanceData: EditorData = { ...editorData(), scope: { kind: 'instance' }, belowLayers: [], below: resolveTheme([]) }
    expect(assess(instanceData, { use: 'fokus' }, library).template?.name).toBe('Fokus Instanz')
    expect(assess(instanceData, { use: 'instance/fokus' }, library).template?.name).toBe('Fokus Instanz')
  })

  it('names the template of an inherited layer from the library, the slug as fallback', () => {
    const below: ThemeLayer = { source: 'instance', template: 'fokus', light: { '--color-accent': INSTANCE_FOKUS } }
    const data: EditorData = { ...editorData(), belowLayers: [below], below: resolveTheme([below]) }
    expect(accentLight(data, {})).toMatchObject({ origin: 'inherited', template: 'fokus', templateName: 'Fokus Instanz' })
    expect(accentLight(data, {}, [])).toMatchObject({ template: 'fokus', templateName: 'fokus' })
  })

  it('setUse sets and clears the reference without mutating', () => {
    const draft: ThemeFile = { light: { 'color-accent': '#123456' } }
    const used = setUse(draft, 'instance/papier')
    expect(used).toEqual({ use: 'instance/papier', light: { 'color-accent': '#123456' } })
    expect(setUse(used, null)).toEqual(draft)
    expect(setUse(used, '')).toEqual(draft)
    expect(draft.use).toBeUndefined()
  })

  const fokus: LibraryEntry = {
    slug: 'fokus',
    name: 'Fokus',
    origin: 'builtin',
    file: { name: 'Fokus', base: { 'chip-style': 'filled', 'font-sans': 'Hanken Grotesk, sans-serif' }, light: { 'color-accent': '#0000ff', 'color-bg': '#ffffff' } },
  }

  it('templateFile embeds the chosen template under the own values, without use and brand (Review Focus 4)', () => {
    const draft: ThemeFile = { name: 'Alt', use: 'fokus', brand: { name: 'X' }, light: { 'color-accent': '#123456' } }
    expect(templateFile(draft, 'Neu', fokus)).toEqual({
      name: 'Neu',
      base: { 'font-sans': 'Hanken Grotesk, sans-serif', 'chip-style': 'filled' },
      light: { 'color-bg': '#ffffff', 'color-accent': '#123456' },
    })
    expect(draft.use).toBe('fokus')
  })

  it('templateFile without a known template saves the own values only, as before', () => {
    const draft: ThemeFile = { name: 'Alt', use: 'missing', light: { 'color-accent': '#123456' } }
    expect(templateFile(draft, 'Neu', null)).toEqual({ name: 'Neu', light: { 'color-accent': '#123456' } })
  })

  it('adoptTemplate replaces the sections with the template, keeps name, brand and use', () => {
    const draft: ThemeFile = {
      name: 'Alt',
      use: 'fokus',
      brand: { name: 'X' },
      light: { 'color-accent': '#123456' },
      dark: { 'color-bg': '#000000' },
    }
    const adopted = adoptTemplate(draft, fokus)
    expect(adopted).toEqual({
      name: 'Alt',
      use: 'fokus',
      brand: { name: 'X' },
      base: { 'font-sans': 'Hanken Grotesk, sans-serif', 'chip-style': 'filled' },
      light: { 'color-bg': '#ffffff', 'color-accent': '#0000ff' },
    })
    expect(Object.keys(adopted.light!)).toEqual(['color-bg', 'color-accent'])
    expect(Object.keys(adopted.base!)).toEqual(['font-sans', 'chip-style'])
    expect(draft.use).toBe('fokus')
    expect(draft.light).toEqual({ 'color-accent': '#123456' })
  })

  describe('templateState', () => {
    const instanceOnly: EditorData = { ...editorData(), scope: { kind: 'instance' }, belowLayers: [], below: resolveTheme([]) }
    const over = (belowLayers: ThemeLayer[]): EditorData => ({ ...editorData(), belowLayers, below: resolveTheme(belowLayers) })

    it('own: template when `use` resolves, custom for values without `use`, none otherwise', () => {
      const s = templateState(editorData(), { use: 'fokus', light: { 'color-accent': '#123456' } }, library)
      expect(s.own).toBe('template')
      expect(s.ownTemplate?.name).toBe('Fokus Space')
      expect(templateState(editorData(), { light: { 'color-accent': '#123456' } }, library)).toMatchObject({ own: 'custom', ownTemplate: null })
      expect(templateState(editorData(), { name: 'X', brand: { name: 'Y' } }, library).own).toBe('none')
      expect(templateState(editorData(), { use: 'nope', light: { 'color-accent': '#123456' } }, library).own).toBe('none')
    })

    it('keeps showing the template after adopting it', () => {
      expect(templateState(editorData(), adoptTemplate({ use: 'instance/fokus' }, library[1]!), library).own).toBe('template')
    })

    it('inherited: the Editorial default without layers below', () => {
      expect(templateState(instanceOnly, {}, library).inherited).toEqual({ kind: 'default' })
    })

    it('inherited: the template of the scope below, named from the library, the slug as fallback', () => {
      // expanded as the API sends it: [template, own] of the instance
      const layers: ThemeLayer[] = [
        { source: 'instance', template: 'fokus', light: { '--color-accent': INSTANCE_FOKUS } },
        { source: 'instance', light: { '--color-bg': '#ffffff' } },
      ]
      expect(templateState(over(layers), {}, library).inherited).toEqual({ kind: 'template', name: 'Fokus Instanz', source: 'instance' })
      expect(templateState(over(layers), {}, []).inherited).toEqual({ kind: 'template', name: 'fokus', source: 'instance' })
      expect(templateState(over([layers[0]!, { source: 'instance' }]), {}, library).inherited.kind).toBe('template')
    })

    it('inherited: own settings of the scope below, or the default when it sets nothing', () => {
      expect(templateState(over([instanceLayer]), {}, library).inherited).toEqual({ kind: 'custom', source: 'instance' })
      expect(templateState(over([{ source: 'instance' }]), {}, library).inherited).toEqual({ kind: 'default' })
    })
  })

  it('embedTemplate puts the template under the own values, clears use, keeps brand', () => {
    const draft: ThemeFile = { use: 'fokus', brand: { name: 'X' }, light: { 'color-accent': '#123456' } }
    expect(embedTemplate(draft, fokus)).toEqual({
      brand: { name: 'X' },
      base: { 'font-sans': 'Hanken Grotesk, sans-serif', 'chip-style': 'filled' },
      light: { 'color-bg': '#ffffff', 'color-accent': '#123456' },
    })
  })
})

describe('setBrandName', () => {
  it('sets the name and keeps the logo pointer, without mutating', () => {
    const draft: ThemeFile = { brand: { logo: 'brand/logo.svg' }, light: { 'color-accent': '#123456' } }
    const named = setBrandName(draft, 'Mein Wiki')
    expect(named).toEqual({ brand: { logo: 'brand/logo.svg', name: 'Mein Wiki' }, light: { 'color-accent': '#123456' } })
    expect(draft.brand).toEqual({ logo: 'brand/logo.svg' })
  })

  it('creates the brand block when there is none', () => {
    expect(setBrandName({}, 'Mein Wiki')).toEqual({ brand: { name: 'Mein Wiki' } })
  })

  it('removes the name with null or an empty string; an emptied block goes', () => {
    const draft: ThemeFile = { brand: { name: 'Mein Wiki' } }
    expect(setBrandName(draft, null)).toEqual({})
    expect(setBrandName(draft, '')).toEqual({})
    expect(setBrandName({ brand: { name: 'X', favicon: 'brand/favicon.svg' } }, null)).toEqual({
      brand: { favicon: 'brand/favicon.svg' },
    })
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
