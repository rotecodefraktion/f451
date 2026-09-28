import { describe, expect, it } from 'vitest'
import { degreeMap, hubIds, nodeVisibility, statusLabel, truncateLabel, visibleEdgeCount } from './model.js'
import type { GraphData } from './types.js'

function fix(): GraphData {
  const node = (id: string, title: string) => ({
    id, title, path: `${id}/index.md`, status: 'released' as const, tags: [], updatedAt: '2026-07-12T00:00:00.000Z',
  })
  return {
    nodes: [node('hub', 'Hub'), node('a', 'Alpha'), node('b', 'Beta'), node('solo', 'Solo')],
    edges: [
      { from: 'a', to: 'hub', type: 'hierarchy', label: '' },
      { from: 'b', to: 'hub', type: 'hierarchy', label: '' },
      { from: 'a', to: 'b', type: 'link', label: '' },
    ],
  }
}

describe('degreeMap/hubIds', () => {
  it('zählt Grad über beide Richtungen; Hubs nach Grad, Ties nach Titel', () => {
    const deg = degreeMap(fix())
    expect(deg.get('hub')).toBe(2)
    expect(deg.get('a')).toBe(2)
    expect(deg.get('solo')).toBe(0)
    // Korrektur zum Brief-Entwurf (Task 4, RED-Lauf): hub/a/b haben alle Grad
    // 2 (a–b ist per 'link' zusätzlich verbunden, nicht nur a/hub) — Tie-Break
    // nach Titel liefert 'Alpha' < 'Beta' < 'Hub', also ['a','b'] statt der
    // ursprünglich angenommenen ['a','hub'].
    expect(hubIds(fix(), 2)).toEqual(['a', 'b'])
  })
})

describe('nodeVisibility', () => {
  it('ohne Filter: alles normal', () => {
    const vis = nodeVisibility(fix(), { query: '', selectedId: null, depth: 3 })
    expect([...vis.values()].every((v) => v === 'normal')).toBe(true)
  })

  it('query dimmt Nicht-Treffer (case-insensitiv), versteckt nichts', () => {
    const vis = nodeVisibility(fix(), { query: 'alp', selectedId: null, depth: 3 })
    expect(vis.get('a')).toBe('normal')
    expect(vis.get('hub')).toBe('dim')
  })

  it('Auswahl + Tiefe versteckt Knoten außerhalb der Sprungweite', () => {
    const vis = nodeVisibility(fix(), { query: '', selectedId: 'solo', depth: 1 })
    expect(vis.get('solo')).toBe('normal')
    expect(vis.get('hub')).toBe('hidden')
  })
})

describe('visibleEdgeCount', () => {
  it('zählt nur Kanten mit eingeblendetem Typ und sichtbaren Endpunkten', () => {
    const g = fix()
    const vis = nodeVisibility(g, { query: '', selectedId: 'solo', depth: 1 })
    expect(visibleEdgeCount(g, vis, new Set())).toBe(0) // alle Nachbarn versteckt
    const all = nodeVisibility(g, { query: '', selectedId: null, depth: 3 })
    expect(visibleEdgeCount(g, all, new Set(['hierarchy']))).toBe(1) // nur der link bleibt
  })
})

describe('statusLabel', () => {
  it('liefert die Legende-Wortlaute des Mockups', () => {
    expect(statusLabel('released')).toBe('Released')
    expect(statusLabel('review')).toBe('Review')
    expect(statusLabel('working')).toBe('Working')
    expect(statusLabel('archived')).toBe('Archiviert')
  })
})

describe('truncateLabel', () => {
  it('lässt kurze Titel unverändert', () => {
    expect(truncateLabel('Deployment')).toBe('Deployment')
  })

  it('kürzt lange Titel mit Ellipsis auf die Maximallänge (inkl. „…")', () => {
    const long = 'Kerneltausch alt — Runbook für den produktiven Cluster'
    const result = truncateLabel(long, 22)
    expect(result.length).toBe(22)
    expect(result.endsWith('…')).toBe(true)
    expect(result).toBe('Kerneltausch alt — Ru…')
  })

  it('Titel genau an der Grenze bleibt unverändert (kein Off-by-one)', () => {
    expect(truncateLabel('1234567890', 10)).toBe('1234567890')
    expect(truncateLabel('12345678901', 10)).toBe('123456789…')
  })
})
