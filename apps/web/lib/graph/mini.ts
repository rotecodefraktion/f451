import { degreeMap } from './model.js'
import type { GraphData } from './types.js'

export interface MiniGraphNeighbor { id: string; title: string; x: number; y: number }
export interface MiniGraphModel { center: { id: string; title: string }; neighbors: MiniGraphNeighbor[] }

/** viewBox des Rail-Mini-Graphen — Maße aus dem Mockup (leseansicht.html). */
export const MINI_VIEW = { width: 240, height: 180, cx: 120, cy: 90, radius: 66 } as const

/**
 * Kürzt `title` auf maximal `max` Zeichen (echtes Ellipsis-Zeichen U+2026,
 * kein Dreipunkt-ASCII) — bei `max` selbst bleibt der Titel unverändert.
 * Genutzt für das Zentrum-Label des Mini-Graphen (Fix-Runde 1, Task 6:
 * ungekürzte Zentrum-Titel liefen aus der Pill).
 */
export function truncateTitle(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title
}

/**
 * Radiales Standbild „Verknüpfte Seiten" (Mockup leseansicht.html): Zentrum
 * = aktuelle Seite, drumherum bis zu `max` direkte Nachbarn — die
 * verknüpfungsstärksten zuerst (Grad im Nachbarschafts-Graphen, Ties nach
 * Titel), gleichmäßig auf dem Kreis verteilt, beginnend oben (-90°).
 * Deterministisch (kein Force-Layout — 6 Elemente brauchen keine Simulation).
 */
export function miniGraphModel(graph: GraphData, centerId: string, max = 5): MiniGraphModel | null {
  const center = graph.nodes.find((n) => n.id === centerId)
  if (!center) return null
  const deg = degreeMap(graph)
  const neighborIds = new Set<string>()
  for (const e of graph.edges) {
    if (e.from === centerId) neighborIds.add(e.to)
    if (e.to === centerId) neighborIds.add(e.from)
  }
  neighborIds.delete(centerId)
  const picked = graph.nodes
    .filter((n) => neighborIds.has(n.id))
    .sort((a, b) => (deg.get(b.id)! - deg.get(a.id)!) || a.title.localeCompare(b.title))
    .slice(0, max)
  if (picked.length === 0) return null
  const neighbors = picked.map((n, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / picked.length
    return {
      id: n.id,
      title: n.title,
      x: Math.round(MINI_VIEW.cx + MINI_VIEW.radius * Math.cos(angle)),
      y: Math.round(MINI_VIEW.cy + MINI_VIEW.radius * Math.sin(angle)),
    }
  })
  return { center: { id: center.id, title: center.title }, neighbors }
}
