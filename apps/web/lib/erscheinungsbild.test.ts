import { describe, expect, it } from 'vitest'
import { istVorschau, leseUeberschreibungen, schreibeUeberschreibungen } from './erscheinungsbild.js'

describe('leseUeberschreibungen / schreibeUeberschreibungen', () => {
  it('gibt zurück, was hineingeschrieben wurde', () => {
    const werte = {
      light: { '--color-bg': '#ffffff' },
      dark: { '--color-bg': '#000000', '--space-4': '2rem' },
      attributes: {},
    }
    expect(leseUeberschreibungen(schreibeUeberschreibungen(werte))).toEqual(werte)
  })

  it('ist ohne gespeicherten Stand leer', () => {
    const leer = { light: {}, dark: {}, attributes: {} }
    expect(leseUeberschreibungen(null)).toEqual(leer)
    expect(leseUeberschreibungen('')).toEqual(leer)
    expect(leseUeberschreibungen(schreibeUeberschreibungen(leer))).toEqual(leer)
  })

  it('verschluckt kaputten Inhalt, statt zu werfen', () => {
    for (const roh of ['kein JSON', '{nope', 'null', '42', '"text"', '["light"]', '{"light":"kaputt"}']) {
      expect(leseUeberschreibungen(roh), roh).toEqual({ light: {}, dark: {}, attributes: {} })
    }
  })

  it('behält den lesbaren Teil und wirft nur den Rest weg', () => {
    expect(leseUeberschreibungen('{"light":{"--color-bg":"#fff","--space-4":7},"dark":null,"grün":{}}')).toEqual({
      light: { '--color-bg': '#fff' },
      dark: {},
      attributes: {},
    })
  })

  it('liest und schreibt die Schalter-Attribute', () => {
    const werte = { light: {}, dark: {}, attributes: { 'chip-style': 'filled', 'code-header': 'on' } }
    expect(leseUeberschreibungen(schreibeUeberschreibungen(werte))).toEqual(werte)
  })

  it('verwirft Attribute außerhalb der Grammatik', () => {
    const roh = JSON.stringify({
      light: {},
      dark: {},
      attributes: { 'chip style': 'x', 'chip-style': 'fil led', theme: 'dark', ok: 'on' },
    })
    expect(leseUeberschreibungen(roh).attributes).toEqual({ ok: 'on' })
  })

  it('marks a preview value and ignores the marker when reading', () => {
    const werte = { light: { '--color-accent': '#aa3300' }, dark: {}, attributes: {} }
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
