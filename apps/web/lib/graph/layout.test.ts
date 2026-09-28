import { describe, expect, it } from 'vitest'
import { clampPopoverPosition, computeLayout, GRAPH_VIEW } from './layout.js'
import type { GraphData } from './types.js'

function fix(n: number): GraphData {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, title: `P${i}`, path: `p${i}/index.md`, status: 'released' as const, tags: [], updatedAt: '2026-07-12T00:00:00.000Z',
  }))
  const edges = nodes.slice(1).map((node) => ({ from: node.id, to: 'p0', type: 'hierarchy' as const, label: '' }))
  return { nodes, edges }
}

describe('computeLayout', () => {
  it('ist deterministisch: gleicher Input ⇒ identische Koordinaten', () => {
    const a = computeLayout(fix(8))
    const b = computeLayout(fix(8))
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('hält alle Knoten innerhalb des Viewports (inkl. Padding)', () => {
    const pos = computeLayout(fix(12))
    for (const { x, y } of pos.values()) {
      expect(x).toBeGreaterThanOrEqual(GRAPH_VIEW.padding)
      expect(x).toBeLessThanOrEqual(GRAPH_VIEW.width - GRAPH_VIEW.padding)
      expect(y).toBeGreaterThanOrEqual(GRAPH_VIEW.padding)
      expect(y).toBeLessThanOrEqual(GRAPH_VIEW.height - GRAPH_VIEW.padding)
    }
  })

  it('leerer Graph ⇒ leere Map', () => {
    expect(computeLayout({ nodes: [], edges: [] }).size).toBe(0)
  })
})

describe('clampPopoverPosition', () => {
  const popover = { width: 250, height: 280 }

  it('Container exakt im Viewbox-Seitenverhältnis: Knotenmitte bleibt unverändert (kein Clamp nötig)', () => {
    const pos = clampPopoverPosition({ x: 500, y: 280 }, { width: 1000, height: 560 }, popover)
    expect(pos).toEqual({ left: 500, top: 272 }) // top an 560-280-8=272 geklemmt
  })

  it('kippt am rechten/unteren Rand nach oben/links, statt über den Container hinauszuragen', () => {
    const pos = clampPopoverPosition({ x: 990, y: 550 }, { width: 1000, height: 560 }, popover)
    expect(pos.left).toBe(1000 - popover.width - 8)
    expect(pos.top).toBe(560 - popover.height - 8)
  })

  it('kippt am linken/oberen Rand nicht unter das margin', () => {
    const pos = clampPopoverPosition({ x: 0, y: 0 }, { width: 1000, height: 560 }, popover)
    expect(pos.left).toBe(8)
    expect(pos.top).toBe(8)
  })

  it('berücksichtigt Letterboxing (Container breiter als das Viewbox-Seitenverhältnis)', () => {
    // scale = min(2000/1000, 560/560) = 1 ⇒ die SVG füllt nur die Höhe, links/rechts
    // bleibt ein 500px-Rand (xMidYMid meet) — die Knotenmitte (x:500 in Viewbox-
    // Koordinaten) landet deshalb bei Pixel 1000, nicht bei 500.
    const pos = clampPopoverPosition({ x: 500, y: 280 }, { width: 2000, height: 560 }, popover)
    expect(pos.left).toBe(1000)
  })

  it('ohne gemessene Container-Größe (0×0, vor dem ersten Messen): sicherer Fallback statt NaN', () => {
    expect(clampPopoverPosition({ x: 500, y: 280 }, { width: 0, height: 0 }, popover)).toEqual({ left: 8, top: 8 })
  })
})
