import { catalog, resolveTheme, tokens, type ThemeTokenName } from '@f451/design-tokens'
import { describe, expect, it } from 'vitest'
import {
  currentMode,
  declarationsToMap,
  overrideNames,
  previewAttributes,
  previewStyle,
  programOverrides,
} from './theme-preview.js'

const defaults = resolveTheme([])
const drafted = resolveTheme([
  {
    source: 'space',
    base: { '--measure': '72ch' },
    light: { '--color-accent': '#123456' },
    dark: { '--color-accent': '#abcdef', '--color-bg': '#101010', '--color-bg-raised': '#202020' },
  },
])

describe('declarationsToMap', () => {
  it('turns `--name: value;` strings back into a map', () => {
    expect(declarationsToMap(['--a: 1px;', '--b:  #fff ;'])).toEqual({ '--a': '1px', '--b': '#fff' })
  })

  it('keeps colons inside the value', () => {
    expect(declarationsToMap(['--x: url(a:b);'])).toEqual({ '--x': 'url(a:b)' })
  })

  it('drops anything that is not a custom property with a value', () => {
    expect(declarationsToMap(['color: red;', '--empty: ;', 'garbage'])).toEqual({})
  })
})

describe('programOverrides', () => {
  it('carries no custom property for the built-in tokens', () => {
    const o = programOverrides(defaults)
    expect(o.light).toEqual({})
    expect(o.dark).toEqual({})
  })

  it('carries only changed tokens, structure ones in both modes', () => {
    const o = programOverrides(drafted)
    expect(o.light).toEqual({ '--measure': '72ch', '--color-accent': '#123456' })
    expect(o.dark).toEqual({ '--measure': '72ch', '--color-accent': '#abcdef', '--color-bg-raised': '#202020' })
  })

  it('leaves dark --color-bg to the panel/page flip', () => {
    expect(programOverrides(drafted).dark['--color-bg']).toBeUndefined()
  })
})

describe('previewStyle', () => {
  const themeNames = (Object.keys(tokens.light) as ThemeTokenName[]).filter((n) => catalog[n].emit === 'css')

  it('carries every theme value of the mode, not only the changed ones', () => {
    const style = previewStyle(defaults, 'light')
    for (const name of themeNames) expect(style[name]).toBe(tokens.light[name])
  })

  it('takes the draft values of the chosen mode', () => {
    expect(previewStyle(drafted, 'light')['--color-accent']).toBe('#123456')
    expect(previewStyle(drafted, 'dark')['--color-accent']).toBe('#abcdef')
  })

  it('leaves out dark --color-bg, keeps it in light', () => {
    expect(previewStyle(drafted, 'dark')['--color-bg']).toBeUndefined()
    expect(previewStyle(drafted, 'light')['--color-bg']).toBe(tokens.light['--color-bg' as ThemeTokenName])
  })

  it('carries structure tokens only when changed', () => {
    expect(previewStyle(drafted, 'light')['--measure']).toBe('72ch')
    expect(previewStyle(defaults, 'light')['--measure']).toBeUndefined()
  })

  it('carries no token without a root value', () => {
    const style = previewStyle(drafted, 'dark')
    for (const name of Object.keys(style)) expect(catalog[name as keyof typeof catalog].emit).toBe('css')
  })
})

describe('overrideNames', () => {
  it('is the union of both modes', () => {
    expect(
      overrideNames({ light: { '--a': '1', '--b': '2' }, dark: { '--b': '3', '--c': '4' }, attributes: {} }).sort(),
    ).toEqual(['--a', '--b', '--c'])
  })
})

describe('switch attributes in the previews', () => {
  it('programOverrides carries the full switch set, defaults included', () => {
    const over = programOverrides(resolveTheme([{ source: 'user', base: { '--chip-style': 'marker' } }]))
    expect(Object.keys(over.attributes)).toHaveLength(12)
    expect(over.attributes['chip-style']).toBe('marker')
    expect(over.attributes['callout-style']).toBe('bar')
  })

  it('previewAttributes prefixes data- and carries every switch', () => {
    const attrs = previewAttributes(defaults)
    expect(Object.keys(attrs)).toHaveLength(12)
    expect(attrs['data-list-marker']).toBe('dash')
  })

  it('previewStyle never carries a switch as a custom property', () => {
    const style = previewStyle(resolveTheme([{ source: 'user', base: { '--chip-style': 'marker' } }]), 'light')
    expect(Object.keys(style).some((k) => k === '--chip-style')).toBe(false)
  })
})

describe('currentMode', () => {
  it('follows data-theme first, then the system preference', () => {
    expect(currentMode('dark', false)).toBe('dark')
    expect(currentMode('light', true)).toBe('light')
    expect(currentMode(null, true)).toBe('dark')
    expect(currentMode('', false)).toBe('light')
  })
})
