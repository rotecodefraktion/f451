import { describe, expect, it } from 'vitest'
import { parseThemeFile } from '../src/theme-file.js'

/**
 * The theme file parser (Stage 1, Task 1.4): file names without dashes become
 * catalog names with dashes, every value passes its grammar, and whatever
 * fails lands in `errors` instead of `layer` — a reader keeps going, a writer
 * refuses (Global Constraints: fail-closed).
 */

const codes = (problems: { code: string }[]) => problems.map((p) => p.code)

describe('parseThemeFile', () => {
  it('accepts a minimal valid file and converts names to catalog names', () => {
    const r = parseThemeFile(
      { name: 'Fokus', base: { measure: '72ch' }, light: { 'color-accent': '#1A2B3C' }, dark: { 'color-accent': '#abcdef' } },
      'instance',
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.layer).toStrictEqual({
      source: 'instance',
      base: { '--measure': '72ch' },
      light: { '--color-accent': '#1a2b3c' },
      dark: { '--color-accent': '#abcdef' },
    })
    // The echo keeps file names and the normalised values.
    expect(r.file).toStrictEqual({
      name: 'Fokus',
      base: { measure: '72ch' },
      light: { 'color-accent': '#1a2b3c' },
      dark: { 'color-accent': '#abcdef' },
    })
  })

  it('treats an empty document as a valid, empty theme', () => {
    const r = parseThemeFile(null, 'space')
    expect(r.errors).toEqual([])
    expect(r.layer).toStrictEqual({ source: 'space' })
    expect(r.file).toStrictEqual({})
  })

  it('lists an unknown token in errors and keeps it out of the layer', () => {
    const r = parseThemeFile({ light: { 'color-accent': '#123456', 'color-nope': '#000000' } }, 'instance')
    expect(codes(r.errors)).toEqual(['token_unknown'])
    expect(r.errors[0]).toMatchObject({ token: '--color-nope', path: 'light.color-nope' })
    expect(r.layer.light).toStrictEqual({ '--color-accent': '#123456' })
    expect(r.file.light).toStrictEqual({ 'color-accent': '#123456' })
  })

  it('rejects a file name written with leading dashes', () => {
    const r = parseThemeFile({ light: { '--color-accent': '#123456' } }, 'instance')
    expect(codes(r.errors)).toEqual(['token_unknown'])
    expect(r.layer.light).toBeUndefined()
  })

  it('drops a locked token with token_locked naming the token (Review Focus 2)', () => {
    const r = parseThemeFile({ base: { 'measure-full': '90%', measure: '70ch' } }, 'instance')
    expect(codes(r.errors)).toEqual(['token_locked'])
    expect(r.errors[0]).toMatchObject({ token: '--measure-full', path: 'base.measure-full' })
    expect(r.errors[0]!.message).toContain('measure-full')
    expect(r.layer.base).toStrictEqual({ '--measure': '70ch' })
  })

  it('drops a value that fails its grammar with value_invalid', () => {
    const r = parseThemeFile({ light: { 'color-accent': 'red' }, base: { measure: '90ch' } }, 'instance')
    expect(codes(r.errors).sort()).toEqual(['value_invalid', 'value_invalid'])
    expect(r.errors.map((e) => e.token).sort()).toEqual(['--color-accent', '--measure'])
    expect(r.layer.light).toBeUndefined()
    expect(r.layer.base).toBeUndefined()
  })

  it('puts a token in the wrong section under value_invalid and names the right one', () => {
    const r = parseThemeFile({ base: { 'color-accent': '#123456' }, light: { measure: '70ch' } }, 'instance')
    expect(codes(r.errors)).toEqual(['value_invalid', 'value_invalid'])
    expect(r.errors[0]!.message).toContain('light or dark')
    expect(r.errors[1]!.message).toContain('base')
    expect(r.layer.base).toBeUndefined()
    expect(r.layer.light).toBeUndefined()
  })

  it('accepts a derived token in a mode section like a theme token', () => {
    const r = parseThemeFile({ light: { 'color-focus': '#00aa00' } }, 'instance')
    expect(r.errors).toEqual([])
    expect(r.layer.light).toStrictEqual({ '--color-focus': '#00aa00' })
  })

  it('accepts a YAML number as a value', () => {
    const r = parseThemeFile({ base: { 'weight-text': 500 } }, 'instance')
    expect(r.errors).toEqual([])
    expect(r.layer.base).toStrictEqual({ '--weight-text': '500' })
  })

  it('accepts use: <slug> and use: instance/<slug>', () => {
    expect(parseThemeFile({ use: 'dark-high' }, 'instance').errors).toEqual([])
    const r = parseThemeFile({ use: 'instance/dark-high' }, 'space')
    expect(r.errors).toEqual([])
    expect(r.file.use).toBe('instance/dark-high')
    // `use` is not a value of this layer; the caller turns the template into its own layer.
    expect(r.layer).toStrictEqual({ source: 'space' })
  })

  it('rejects a use that is not a slug reference with use_invalid', () => {
    for (const use of ['../x', 'space/x', 'Dark-High', 'instance/', 42]) {
      const r = parseThemeFile({ use }, 'space')
      expect(codes(r.errors)).toEqual(['use_invalid'])
      expect(r.file.use).toBeUndefined()
    }
  })

  it('rejects use inside a template with template_no_nesting (Review Focus 3)', () => {
    const r = parseThemeFile({ use: 'dark-high', light: { 'color-accent': '#123456' } }, 'instance', { allowUse: false })
    expect(codes(r.errors)).toEqual(['template_no_nesting'])
    expect(r.errors[0]!.path).toBe('use')
    expect(r.file.use).toBeUndefined()
    // The template's own values still parse.
    expect(r.layer.light).toStrictEqual({ '--color-accent': '#123456' })
  })

  it('rejects a favicon where it is not allowed', () => {
    const r = parseThemeFile({ brand: { name: 'Mein Wiki', favicon: 'brand/favicon.svg' } }, 'instance', { allowFavicon: false })
    expect(codes(r.errors)).toEqual(['brand_favicon_instance_only'])
    expect(r.file.brand).toStrictEqual({ name: 'Mein Wiki' })
  })

  it('allows the favicon on the instance by default and refuses it on a space', () => {
    const ok = parseThemeFile({ brand: { favicon: 'brand/favicon.svg' } }, 'instance')
    expect(ok.errors).toEqual([])
    expect(ok.file.brand).toStrictEqual({ favicon: 'brand/favicon.svg' })
    const space = parseThemeFile({ brand: { favicon: 'brand/favicon.svg' } }, 'space')
    expect(codes(space.errors)).toEqual(['brand_favicon_instance_only'])
  })

  it('accepts a brand logo under brand/ and rejects other paths', () => {
    expect(parseThemeFile({ brand: { logo: 'brand/logo.svg' } }, 'space').errors).toEqual([])
    for (const logo of ['/brand/logo.svg', 'brand/../x.svg', '../brand/logo.svg', 'logo.svg', 'brand/', 'brand\\logo.svg']) {
      const r = parseThemeFile({ brand: { logo } }, 'space')
      expect(codes(r.errors), logo).toEqual(['brand_path_invalid'])
      expect(r.file.brand).toBeUndefined()
    }
  })

  it('warns about unknown top-level keys and trimmed values but keeps the file valid', () => {
    const r = parseThemeFile({ name: ' Fokus ', fonts: {}, light: { 'color-accent': ' #123456 ' } }, 'instance')
    expect(r.errors).toEqual([])
    expect(codes(r.warnings).sort()).toEqual(['key_unknown', 'value_trimmed', 'value_trimmed'])
    expect(r.file.name).toBe('Fokus')
    expect(r.layer.light).toStrictEqual({ '--color-accent': '#123456' })
  })

  it('rejects a document that is not a map', () => {
    const r = parseThemeFile('color-accent: #123', 'instance')
    expect(codes(r.errors)).toEqual(['value_invalid'])
    expect(r.layer).toStrictEqual({ source: 'instance' })
  })
})

describe('migration of the heading tokens (1.2.5)', () => {
  it("reads heading-number: counter(sec) '.' as numeral with a warning", () => {
    const parsed = parseThemeFile({ base: { 'heading-number': "counter(sec) '.'" } }, 'instance')
    expect(parsed.errors).toEqual([])
    expect(parsed.layer.base).toEqual({ '--heading-number': 'numeral' })
    expect(parsed.file.base).toEqual({ 'heading-number': 'numeral' })
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: 'value_migrated', token: '--heading-number', path: 'base.heading-number' }),
    ])
  })

  it('reads heading-number-sub as heading-depth (none → top, inline-block → all)', () => {
    const top = parseThemeFile({ base: { 'heading-number-sub': 'none' } }, 'instance')
    expect(top.layer.base).toEqual({ '--heading-depth': 'top' })
    const all = parseThemeFile({ base: { 'heading-number-sub': 'inline-block' } }, 'space')
    expect(all.layer.base).toEqual({ '--heading-depth': 'all' })
    expect(all.file.base).toEqual({ 'heading-depth': 'all' })
    expect(all.errors).toEqual([])
    expect(all.warnings.map((w) => w.code)).toEqual(['value_migrated'])
  })

  it('leaves new-form values alone and rejects unknown ones', () => {
    const fine = parseThemeFile({ base: { 'heading-number': 'none', 'heading-depth': 'all' } }, 'instance')
    expect(fine.warnings).toEqual([])
    expect(fine.layer.base).toEqual({ '--heading-number': 'none', '--heading-depth': 'all' })
    const bad = parseThemeFile({ base: { 'heading-number-sub': 'block' } }, 'instance')
    expect(bad.errors.map((e) => e.code)).toEqual(['token_unknown'])
  })

  it('a switch in light/dark is a section error like any structure token', () => {
    const parsed = parseThemeFile({ light: { 'chip-style': 'filled' } }, 'instance')
    expect(parsed.errors.map((e) => e.code)).toEqual(['value_invalid'])
  })
})
