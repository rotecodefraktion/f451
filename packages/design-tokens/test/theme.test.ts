import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_TOKENS,
  attributeValues,
  checkRules,
  resolveTheme,
  toAttributes,
  toCssDeclarations,
  type ThemeLayer,
} from '../src/theme.js'
import { tokens } from '../src/tokens.js'

/**
 * The layer resolver (Stage 1, Task 1.3): default ← instance ← space ← user,
 * mixed per token and per mode, with an origin mark on every value. Rules are
 * checked on the resolved set so an inherited value counts (Review Focus 5).
 */

const everyOrigin = (map: Record<string, { source: string }>) => new Set(Object.values(map).map((o) => o.source))

describe('resolveTheme', () => {
  it('returns the defaults with origin default everywhere for an empty list', () => {
    const r = resolveTheme([])
    expect(r.base).toEqual(tokens.structure)
    expect(r.light).toEqual(tokens.light)
    expect(r.dark).toEqual(tokens.dark)
    expect(everyOrigin(r.origin.base)).toEqual(new Set(['default']))
    expect(everyOrigin(r.origin.light)).toEqual(new Set(['default']))
    expect(everyOrigin(r.origin.dark)).toEqual(new Set(['default']))
  })

  it('applies one layer per token and per mode, leaving the other mode alone', () => {
    const r = resolveTheme([{ source: 'instance', light: { '--color-accent': '#123456' } }])
    expect(r.light['--color-accent']).toBe('#123456')
    expect(r.origin.light['--color-accent']).toStrictEqual({ source: 'instance' })
    expect(r.dark['--color-accent']).toBe(tokens.dark['--color-accent'])
    expect(r.origin.dark['--color-accent']).toStrictEqual({ source: 'default' })
    // A neighbour in the same mode is untouched.
    expect(r.light['--color-bg']).toBe(tokens.light['--color-bg'])
    expect(r.origin.light['--color-bg']).toStrictEqual({ source: 'default' })
  })

  it('lets the later layer win and inherits what it leaves out', () => {
    const r = resolveTheme([
      { source: 'instance', base: { '--measure': '72ch' }, light: { '--color-accent': '#111111' } },
      { source: 'space', light: { '--color-accent': '#222222' } },
    ])
    expect(r.light['--color-accent']).toBe('#222222')
    expect(r.origin.light['--color-accent']).toStrictEqual({ source: 'space' })
    expect(r.base['--measure']).toBe('72ch')
    expect(r.origin.base['--measure']).toStrictEqual({ source: 'instance' })
  })

  it('carries the template slug into the origin', () => {
    const r = resolveTheme([
      { source: 'space', template: 'fokus', light: { '--color-accent': '#333333' } },
      { source: 'space', light: { '--color-bg': '#ffffff' } },
    ])
    expect(r.origin.light['--color-accent']).toStrictEqual({ source: 'space', template: 'fokus' })
    expect(r.origin.light['--color-bg']).toStrictEqual({ source: 'space' })
  })

  it('carries an explicitly set derived colour with its origin, leaving the other mode alone', () => {
    const r = resolveTheme([{ source: 'instance', light: { '--color-focus': '#00aa00' } }])
    expect(r.light['--color-focus']).toBe('#00aa00')
    expect(r.origin.light['--color-focus']).toStrictEqual({ source: 'instance' })
    expect('--color-focus' in r.dark).toBe(false)
    expect('--color-focus' in r.origin.dark).toBe(false)
    expect(toCssDeclarations(r).light).toEqual(['--color-focus: #00aa00;'])
  })

  it('leaves an unset derived colour absent — its default is the formula, not a value', () => {
    const r = resolveTheme([])
    expect('--color-focus' in r.light).toBe(false)
    expect('--color-border-hair' in r.origin.light).toBe(false)
    expect(Object.keys(r.light)).toEqual(Object.keys(tokens.light))
  })

  it('drops names the catalog does not know instead of throwing (fail-closed)', () => {
    const stray = { source: 'user', light: { '--no-such-token': '#000000' } } as unknown as ThemeLayer
    const r = resolveTheme([stray])
    expect(r.light).toEqual(tokens.light)
    expect('--no-such-token' in r.light).toBe(false)
  })
})

describe('checkRules', () => {
  it('accepts the defaults', () => {
    expect(checkRules(resolveTheme([]))).toEqual([])
  })

  it('rejects a --space-* step below its predecessor', () => {
    const v = checkRules(resolveTheme([{ source: 'instance', base: { '--space-3': '0.4rem' } }]))
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('space-monotonic')
    expect(v[0]!.tokens).toEqual(['--space-2', '--space-3'])
    expect(v[0]!.message).toContain('--space-3 0.4rem (instance)')
    expect(v[0]!.message).toContain('--space-2 0.5rem (default)')
  })

  it('requires --weight-strong at least 100 above --weight-text', () => {
    const v = checkRules(resolveTheme([{ source: 'user', base: { '--weight-strong': '450' } }]))
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('weight-gap')
    expect(v[0]!.tokens).toEqual(['--weight-text', '--weight-strong'])
    expect(checkRules(resolveTheme([{ source: 'user', base: { '--weight-strong': '500' } }]))).toEqual([])
  })

  it('names both tokens and the layer of each when --measure-wide falls below an inherited --measure', () => {
    // Review Focus 5: the space file only sets --measure-wide; --measure comes from the instance.
    const space: ThemeLayer = { source: 'space', base: { '--measure-wide': '70ch' } }
    const v = checkRules(resolveTheme([{ source: 'instance', base: { '--measure': '78ch' } }, space]))
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('measure-order')
    expect(v[0]!.tokens).toEqual(['--measure', '--measure-wide'])
    expect(v[0]!.message).toContain('--measure-wide 70ch (space)')
    expect(v[0]!.message).toContain('--measure 78ch (instance)')
    // The same space file passes when the instance sets a smaller --measure.
    expect(checkRules(resolveTheme([{ source: 'instance', base: { '--measure': '60ch' } }, space]))).toEqual([])
  })

  it('names the template when the offending value comes from one', () => {
    const v = checkRules(
      resolveTheme([{ source: 'instance', template: 'werkbank', base: { '--weight-strong': '400' } }]),
    )
    expect(v[0]!.message).toContain('--weight-strong 400 (instance, template werkbank)')
  })

  it('leaves values it cannot read alone', () => {
    const v = checkRules(resolveTheme([{ source: 'instance', base: { '--measure': 'calc(60ch + 1rem)' } }]))
    expect(v).toEqual([])
  })

  it('requires --topbar on for --pane-controls topbar, naming both tokens', () => {
    const v = checkRules(resolveTheme([{ source: 'instance', base: { '--pane-controls': 'topbar' } }]))
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('pane-controls-needs-topbar')
    expect(v[0]!.tokens).toEqual(['--topbar', '--pane-controls'])
    expect(v[0]!.message).toContain('--pane-controls topbar (instance)')
    expect(v[0]!.message).toContain('--topbar off (default)')
    const ok = checkRules(
      resolveTheme([{ source: 'instance', base: { '--pane-controls': 'topbar', '--topbar': 'on' } }]),
    )
    expect(ok).toEqual([])
  })
})

describe('toCssDeclarations', () => {
  it('emits nothing for the defaults', () => {
    expect(toCssDeclarations(resolveTheme([]))).toEqual({ root: [], light: [], dark: [] })
  })

  it('emits only what a layer changed, as `--name: value;`', () => {
    const css = toCssDeclarations(
      resolveTheme([
        { source: 'instance', base: { '--measure': '72ch' }, light: { '--color-accent': '#123456' } },
        { source: 'user', dark: { '--color-bg': '#000000' } },
      ]),
    )
    expect(css.root).toEqual(['--measure: 72ch;'])
    expect(css.light).toEqual(['--color-accent: #123456;'])
    expect(css.dark).toEqual(['--color-bg: #000000;'])
  })

  it('keeps generator-only tokens out of the stylesheet, like css.ts does', () => {
    const css = toCssDeclarations(resolveTheme([{ source: 'instance', light: { '--diagram-lane-fill': '#000000' } }]))
    expect(css.light).toEqual([])
  })
})

describe('toAttributes / attributeValues', () => {
  it('lists the seventeen switches', () => {
    expect(ATTRIBUTE_TOKENS).toHaveLength(17)
    expect(ATTRIBUTE_TOKENS).toContain('--chip-style')
    expect(ATTRIBUTE_TOKENS).toContain('--pane-controls')
  })

  it('is empty for the defaults and for a layer that sets the default value', () => {
    expect(toAttributes(resolveTheme([]))).toEqual({})
    const same: ThemeLayer = { source: 'instance', base: { '--callout-style': 'bar' } }
    // origin says instance, value is the default — the DOM only needs deviations,
    // the origin mark on the settings page still says "instance" (Review Focus 2)
    const resolved = resolveTheme([same])
    expect(resolved.origin.base['--callout-style'].source).toBe('instance')
    expect(toAttributes(resolved)).toEqual({})
  })

  it('names deviations without the dashes, later layer wins', () => {
    const instance: ThemeLayer = { source: 'instance', base: { '--chip-style': 'filled', '--code-header': 'on' } }
    const user: ThemeLayer = { source: 'user', base: { '--chip-style': 'marker' } }
    expect(toAttributes(resolveTheme([instance, user]))).toEqual({ 'chip-style': 'marker', 'code-header': 'on' })
  })

  it('attributeValues carries every switch, defaults included', () => {
    const values = attributeValues(resolveTheme([{ source: 'space', base: { '--list-marker': 'disc' } }]))
    expect(Object.keys(values)).toHaveLength(17)
    expect(values['list-marker']).toBe('disc')
    expect(values['callout-style']).toBe('bar')
  })

  it('toCssDeclarations never emits a switch', () => {
    const css = toCssDeclarations(resolveTheme([{ source: 'instance', base: { '--chip-style': 'filled' } }]))
    expect(css.root.some((d) => d.startsWith('--chip-style'))).toBe(false)
  })
})
