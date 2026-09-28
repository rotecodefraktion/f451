import { catalog, tokenNames } from '@f451/design-tokens'
import { describe, expect, it } from 'vitest'
import { baueGruppen, leseUeberschreibungen, schreibeUeberschreibungen, type Modus } from './erscheinungsbild.js'

/**
 * Was hier geprüft wird, ist die Zusage der Seite an ihre Quelle: Sie zeigt den
 * Katalog vollständig und unverändert an — jedes Token, in seiner Gruppe, in
 * seiner Reihenfolge, mit seinem Sperrgrund. Eine stille Lücke (ein Token, das
 * die Anzeige verschluckt) fiele sonst erst auf, wenn jemand es sucht.
 */

const zeilen = (modus: Modus) => baueGruppen(modus).flatMap((g) => g.zeilen)
const zeile = (modus: Modus, name: string) => zeilen(modus).find((z) => z.name === name)!

describe('baueGruppen', () => {
  it('zeigt jedes Token des Katalogs, in dessen Reihenfolge', () => {
    for (const modus of ['light', 'dark'] as const) {
      expect(zeilen(modus).map((z) => z.name), modus).toEqual(tokenNames)
    }
    expect(tokenNames).toHaveLength(134)
  })

  it('gruppiert in der Reihenfolge, in der die Gruppen im Katalog auftauchen', () => {
    const erwartet = [...new Set(tokenNames.map((n) => catalog[n].group))]
    expect(baueGruppen('light').map((g) => g.titel)).toEqual(erwartet)
  })

  it('übernimmt die Rolle im Klartext aus dem Katalog', () => {
    expect(zeile('light', '--color-bg').rolle).toBe(catalog['--color-bg'].role)
  })

  it('liefert je Modus den ausgelieferten Wert', () => {
    expect(zeile('light', '--color-bg').wert).toBe('#fffdf8')
    expect(zeile('dark', '--color-bg').wert).toBe('#1a1917')
    // Theme-unabhängig: in beiden Modi derselbe Wert.
    expect(zeile('dark', '--space-4').wert).toBe(zeile('light', '--space-4').wert)
  })

  it('rechnet abgeleitete Farben zu dem Wert aus, der im Browser ankommt', () => {
    // Mischung aus --color-text 5 % in --color-bg — als Hex, damit Farbwähler
    // und Kontrast damit arbeiten können.
    expect(zeile('light', '--color-surface-hover').wert).toMatch(/^#[0-9a-f]{6}$/)
    expect(zeile('dark', '--color-surface-hover').wert).not.toBe(zeile('light', '--color-surface-hover').wert)
    expect(zeile('light', '--color-surface-hover').istFarbe).toBe(true)
  })

  it('lässt dem Schleier seine Deckung, statt ihn als Farbe auszugeben', () => {
    expect(zeile('light', '--color-scrim').wert).toBe('color-mix(in srgb, #0b0a09 62%, transparent)')
    expect(zeile('light', '--color-scrim').istFarbe).toBe(false)
  })

  it('kennt nur Farben als Farben', () => {
    expect(zeile('light', '--shadow-sm').istFarbe).toBe(false)
    expect(zeile('light', '--text-md').istFarbe).toBe(false)
    expect(zeile('light', '--color-accent').istFarbe).toBe(true)
  })

  it('gibt für Tokens ohne Wurzelwert einen leeren Wert', () => {
    // Die drei mit `emit: 'component'` — sie werden dort gesetzt, wo sie
    // gelten, und haben an der Wurzel bewusst keinen Wert (s. catalog.ts).
    const ohneWurzelwert = tokenNames.filter((n) => catalog[n].emit === 'component')
    expect(ohneWurzelwert).toEqual(['--layout-note-x', '--crumbs-mid', '--crumbs-more'])
    for (const name of ohneWurzelwert) {
      expect(zeile('light', name).wert, name).toBe('')
      expect(zeile('light', name).istFarbe, name).toBe(false)
    }
  })

  it('zeigt ein gesperrtes Token mitsamt seinem Grund — und lässt es stehen', () => {
    const gesperrt = zeile('light', '--measure')
    expect(gesperrt.freigegeben).toBe(false)
    expect(gesperrt.sperrgrund).toBe(catalog['--measure'].lockReason)

    const frei = zeile('light', '--color-bg')
    expect(frei.freigegeben).toBe(true)
    expect(frei.sperrgrund).toBeUndefined()

    // Kein gesperrtes Token bleibt ohne Begründung: eine Sperre ohne Grund
    // sieht auf der Seite aus wie ein fehlendes Feature.
    for (const z of zeilen('light')) {
      if (!z.freigegeben) expect(z.sperrgrund, z.name).toBeTruthy()
    }
  })

  it('nennt bei Farben den Kontrast gegen ihre Fläche', () => {
    expect(zeile('light', '--color-text').kontrast).toEqual({ wert: 17.08, gegen: '--color-bg' })
    // Ohne Bezug in der Paartabelle bleibt das Feld leer, statt etwas zu erfinden.
    expect(zeile('light', '--color-bg').kontrast).toBeUndefined()
    expect(zeile('light', '--space-4').kontrast).toBeUndefined()
  })
})

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
})
