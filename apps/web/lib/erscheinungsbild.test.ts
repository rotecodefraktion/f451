import { describe, expect, it } from 'vitest'
import { istVorschau, leseUeberschreibungen, schreibeUeberschreibungen } from './erscheinungsbild.js'

describe('leseUeberschreibungen / schreibeUeberschreibungen', () => {
  it('gibt zurück, was hineingeschrieben wurde', () => {
    const werte = { light: { '--color-bg': '#ffffff' }, dark: { '--color-bg': '#000000', '--space-4': '2rem' } }
    expect(leseUeberschreibungen(schreibeUeberschreibungen(werte))).toEqual(werte)
  })

  it('ist ohne gespeicherten Stand leer', () => {
    expect(leseUeberschreibungen(null)).toEqual({ light: {}, dark: {} })
    expect(leseUeberschreibungen('')).toEqual({ light: {}, dark: {} })
    expect(leseUeberschreibungen(schreibeUeberschreibungen({ light: {}, dark: {} }))).toEqual({ light: {}, dark: {} })
  })

  it('verschluckt kaputten Inhalt, statt zu werfen', () => {
    for (const roh of ['kein JSON', '{nope', 'null', '42', '"text"', '["light"]', '{"light":"kaputt"}']) {
      expect(leseUeberschreibungen(roh), roh).toEqual({ light: {}, dark: {} })
    }
  })

  it('behält den lesbaren Teil und wirft nur den Rest weg', () => {
    expect(leseUeberschreibungen('{"light":{"--color-bg":"#fff","--space-4":7},"dark":null,"grün":{}}')).toEqual({
      light: { '--color-bg': '#fff' },
      dark: {},
    })
  })

  it('marks a preview value and ignores the marker when reading', () => {
    const werte = { light: { '--color-accent': '#aa3300' }, dark: {} }
    const vorschau = schreibeUeberschreibungen(werte, { preview: true })
    expect(JSON.parse(vorschau)).toEqual({ ...werte, preview: true })
    expect(leseUeberschreibungen(vorschau)).toEqual(werte)
    expect(istVorschau(vorschau)).toBe(true)
    expect(istVorschau(schreibeUeberschreibungen(werte))).toBe(false)
    for (const roh of [null, '', 'kein JSON', 'null', '{"preview":"true"}']) {
      expect(istVorschau(roh), String(roh)).toBe(false)
    }
  })
})
