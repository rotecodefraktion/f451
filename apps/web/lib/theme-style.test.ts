import { describe, expect, it } from 'vitest'
import { themeAttributes, themeStyleText, themeStylesheetLinks } from './theme-style.js'

describe('themeStylesheetLinks', () => {
  it('keeps the instance and the space stylesheet in the given order', () => {
    expect(
      themeStylesheetLinks(['/api/theme/stylesheet?v=abc1234', '/api/spaces/team%20docs/theme/stylesheet?v=def5678']),
    ).toEqual(['/api/theme/stylesheet?v=abc1234', '/api/spaces/team%20docs/theme/stylesheet?v=def5678'])
  })

  it('keeps an instance-only list (space without own CSS)', () => {
    expect(themeStylesheetLinks(['/api/theme/stylesheet?v=abc1234'])).toEqual(['/api/theme/stylesheet?v=abc1234'])
  })

  it('drops everything that is not one of the two stylesheet routes with ?v=', () => {
    expect(
      themeStylesheetLinks([
        '/api/theme/stylesheet',
        '/api/theme/stylesheet?v=',
        '/api/theme/stylesheet?v=abc&x=1',
        'https://evil.example/api/theme/stylesheet?v=abc',
        '//evil.example/api/theme/stylesheet?v=abc',
        '/api/theme/fonts/a.woff2',
        '/api/spaces/a/b/theme/stylesheet?v=abc',
        '/api/spaces/../theme/stylesheet?v=abc',
        '/api/spaces//theme/stylesheet?v=abc',
        '/custom.css',
        'javascript:alert(1)',
        42 as unknown as string,
      ]),
    ).toEqual([])
  })

  it('returns none with skip, for null and for a non-array', () => {
    expect(themeStylesheetLinks(['/api/theme/stylesheet?v=abc1234'], { skip: true })).toEqual([])
    expect(themeStylesheetLinks(null)).toEqual([])
    expect(themeStylesheetLinks(undefined)).toEqual([])
    expect(themeStylesheetLinks('/api/theme/stylesheet?v=abc' as unknown as string[])).toEqual([])
  })
})

describe('themeStyleText', () => {
  it('returns an empty string for empty input', () => {
    expect(themeStyleText({ root: [], light: [], dark: [] })).toBe('')
    expect(themeStyleText(null)).toBe('')
  })

  it('emits only the :root block for root declarations', () => {
    expect(themeStyleText({ root: ['--radius-md: 6px;'], light: [], dark: [] })).toBe(':root{--radius-md: 6px;}')
  })

  it('puts light declarations into :root after root', () => {
    expect(themeStyleText({ root: ['--radius-md: 6px;'], light: ['--color-accent: #0b5fa5;'], dark: [] })).toBe(
      ':root{--radius-md: 6px;--color-accent: #0b5fa5;}',
    )
  })

  it('emits the dark selector and the media block for dark declarations only', () => {
    expect(themeStyleText({ root: [], light: [], dark: ['--color-accent: #7fb2e5;'] })).toBe(
      '[data-theme="dark"]{--color-accent: #7fb2e5;}' +
        '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--color-accent: #7fb2e5;}}',
    )
  })

  it('emits all blocks when both are set', () => {
    expect(
      themeStyleText({
        root: ['--radius-md: 6px;'],
        light: ['--color-accent: #0b5fa5;'],
        dark: ['--color-accent: #7fb2e5;'],
      }),
    ).toBe(
      ':root{--radius-md: 6px;--color-accent: #0b5fa5;}' +
        '[data-theme="dark"]{--color-accent: #7fb2e5;}' +
        '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--color-accent: #7fb2e5;}}',
    )
  })

  it('drops declarations that could close the style element', () => {
    expect(themeStyleText({ root: ['--x: </style>;', '--radius-md: 6px;'], light: [], dark: [] })).toBe(
      ':root{--radius-md: 6px;}',
    )
  })
})

describe('themeAttributes', () => {
  it('prefixes the names with data-', () => {
    expect(themeAttributes({ 'chip-style': 'filled', 'code-header': 'on' })).toEqual({ 'data-chip-style': 'filled', 'data-code-header': 'on' })
  })

  it('drops names and values outside the attribute grammar and the reserved names', () => {
    expect(
      themeAttributes({ 'chip style': 'filled', 'chip-style': 'fil led', 'chip-style"': 'x', theme: 'dark', nav: 'off', rail: 'off', altlasten: 'da' }),
    ).toEqual({})
  })

  it('is empty without input', () => {
    expect(themeAttributes(undefined)).toEqual({})
    expect(themeAttributes(null)).toEqual({})
  })
})
