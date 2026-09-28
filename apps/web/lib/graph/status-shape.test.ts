import { describe, expect, it } from 'vitest'
import { statusShape } from './status-shape.js'
import type { GraphNodeStatus } from './types.js'

const ALL: GraphNodeStatus[] = ['released', 'review', 'working', 'archived']

/**
 * Zugesicherte Eigenschaft 3 der Erscheinungsbild-Spec: „Statusfarben tragen
 * immer zusätzlich Zeichen und Wort." Die Graph-Knoten haben das gebrochen —
 * `working`/`review`/`released` unterschieden sich AUSSCHLIESSLICH in Füllung
 * und Ringfarbe (Befund 5 im Bericht H5, s. Dateiende von
 * `app/styles/65-graph.css`). Diese Fälle halten das farbfreie Merkmal fest:
 * vier Zustände, vier verschiedene Formen — und zwar so, dass ein späterer
 * Eingriff, der zwei Zustände wieder gleich zeichnet, hier auffällt.
 */
describe('statusShape: vier Zustände, vier unterscheidbare Formen', () => {
  it('kein Zustand teilt seine Form mit einem anderen', () => {
    const keys = ALL.map((status) => JSON.stringify(statusShape(status, 9)))
    expect(new Set(keys).size).toBe(ALL.length)
  })

  it('jede Form ist zeichenbares SVG: Kreis mit Radius oder Pfad mit d', () => {
    for (const status of ALL) {
      const shape = statusShape(status, 9)
      if (shape.kind === 'circle') {
        expect(shape.r).toBeGreaterThan(0)
      } else {
        // Geschlossener Pfad (`Z`), ausschließlich Zahlen und die Befehle M/L/H/V/Z
        // — kein `NaN` und keine `undefined`, die stumm eine leere Fläche ergeben.
        expect(shape.d).toMatch(/^M[-\d. LHVZ]*Z$/)
        expect(shape.d).not.toContain('NaN')
      }
    }
  })

  it('die Formen sind in den Kreis mit Radius r gestellt (Geometrie des Bauteils bleibt gültig)', () => {
    const r = 9
    // Toleranz: das Dreieck ist bewusst 12 % größer gerechnet, damit es neben
    // Kreis, Raute und Quadrat nicht kleiner WIRKT (s. status-shape.ts).
    const maxAllowed = r * 1.13
    for (const status of ALL) {
      const shape = statusShape(status, r)
      const coords =
        shape.kind === 'circle'
          ? [shape.r]
          : (shape.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      expect(coords.length).toBeGreaterThan(0)
      for (const value of coords) {
        expect(Math.abs(value)).toBeLessThanOrEqual(maxAllowed)
      }
    }
  })

  it('skaliert mit r — die Hub- und Auswahl-Radien des Bauteils (9/11/13) bleiben unterscheidbar groß', () => {
    for (const status of ALL) {
      const small = statusShape(status, 9)
      const large = statusShape(status, 13)
      expect(JSON.stringify(small)).not.toBe(JSON.stringify(large))
    }
  })
})
