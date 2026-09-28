import { describe, expect, it } from 'vitest'
import { miniGraphModel, truncateTitle } from './mini.js'
import type { GraphData } from './types.js'

function fix(neighborCount: number): GraphData {
  const node = (id: string, title: string) => ({
    id, title, path: `${id}/index.md`, status: 'released' as const, tags: [], updatedAt: '2026-07-12T00:00:00.000Z',
  })
  const nodes = [node('c', 'Zentrum'), ...Array.from({ length: neighborCount }, (_, i) => node(`n${i}`, `Nachbar ${i}`))]
  const edges = Array.from({ length: neighborCount }, (_, i) => ({ from: 'c', to: `n${i}`, type: 'link' as const, label: '' }))
  return { nodes, edges }
}

describe('miniGraphModel', () => {
  it('liefert Zentrum + Nachbarn mit radialen Positionen im 240×180-viewBox', () => {
    const m = miniGraphModel(fix(3), 'c')
    expect(m).not.toBeNull()
    expect(m!.center).toEqual({ id: 'c', title: 'Zentrum' })
    expect(m!.neighbors).toHaveLength(3)
    for (const n of m!.neighbors) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(240)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(180)
    }
    // Deterministisch:
    expect(miniGraphModel(fix(3), 'c')).toEqual(m)
  })

  it('kappt auf max 5 Nachbarn', () => {
    expect(miniGraphModel(fix(8), 'c')!.neighbors).toHaveLength(5)
  })

  it('ohne Nachbarn → null (Sektion erscheint dann nicht)', () => {
    expect(miniGraphModel({ nodes: [fix(0).nodes[0]!], edges: [] }, 'c')).toBeNull()
  })

  it('unbekanntes Zentrum → null', () => {
    expect(miniGraphModel(fix(2), 'nope')).toBeNull()
  })
})

describe('truncateTitle', () => {
  it('lässt Titel mit genau max Zeichen unverändert', () => {
    const title = 'a'.repeat(24)
    expect(truncateTitle(title, 24)).toBe(title)
  })

  it('kürzt Titel mit max+1 Zeichen auf max-1 Zeichen plus Ellipsis', () => {
    const title = 'a'.repeat(25)
    const result = truncateTitle(title, 24)
    expect(result).toBe(`${'a'.repeat(23)}…`)
    expect(result).toHaveLength(24)
  })

  it('nutzt das echte Ellipsis-Zeichen U+2026', () => {
    expect(truncateTitle('a'.repeat(25), 24).endsWith('…')).toBe(true)
  })
})
