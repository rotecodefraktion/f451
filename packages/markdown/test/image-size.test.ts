import { describe, expect, it } from 'vitest'
import { formatImageAlt, parseImageAltSize } from '../src/image-size.js'

describe('parseImageAltSize', () => {
  it('parst `Alt|400` → Breite', () => {
    expect(parseImageAltSize('Programmablauf|400')).toEqual({ alt: 'Programmablauf', width: 400, height: undefined })
  })
  it('parst `Alt|400x300` → Breite + Höhe', () => {
    expect(parseImageAltSize('d|400x300')).toEqual({ alt: 'd', width: 400, height: 300 })
  })
  it('letztes `|` gewinnt (greedy)', () => {
    expect(parseImageAltSize('a|b|400')).toEqual({ alt: 'a|b', width: 400, height: undefined })
  })
  it('leerer Alt mit Suffix', () => {
    expect(parseImageAltSize('|400')).toEqual({ alt: '', width: 400, height: undefined })
  })
  it('kein Suffix → null', () => {
    expect(parseImageAltSize('ganz normal')).toBeNull()
    expect(parseImageAltSize('a|b')).toBeNull()
    expect(parseImageAltSize(null)).toBeNull()
    expect(parseImageAltSize(undefined)).toBeNull()
  })
})

describe('formatImageAlt ist exakte Inverse von parseImageAltSize', () => {
  for (const alt of ['Programmablauf|400', 'd|400x300', 'a|b|400', '|400', 'Alt |400']) {
    it(`roundtrip byte-identisch: ${JSON.stringify(alt)}`, () => {
      const parsed = parseImageAltSize(alt)!
      expect(parsed).not.toBeNull()
      expect(formatImageAlt(parsed.alt, parsed.width, parsed.height)).toBe(alt)
    })
  }
  it('ohne width bleibt der Alt-Text unverändert', () => {
    expect(formatImageAlt('nur alt', null, null)).toBe('nur alt')
    expect(formatImageAlt(null)).toBe('')
  })
})
