import { describe, expect, it } from 'vitest'
import { themeStyleText } from './theme-style.js'

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
