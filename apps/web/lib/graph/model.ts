import type { GraphData, GraphNodeStatus } from './types.js'

/** Grad pro Knoten (beide Richtungen — der Graph ist für die Anzeige
 *  ungerichtet genug: „wie verknüpft ist die Seite?"). */
export function degreeMap(graph: GraphData): Map<string, number> {
  const deg = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]))
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1)
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1)
  }
  return deg
}

/** Die `count` verknüpfungsstärksten Seiten (Minitree-Punkte, `is-hub`).
 *  Ties deterministisch nach Titel. */
export function hubIds(graph: GraphData, count = 5): string[] {
  const deg = degreeMap(graph)
  return [...graph.nodes]
    .sort((a, b) => (deg.get(b.id)! - deg.get(a.id)!) || a.title.localeCompare(b.title))
    .slice(0, count)
    .map((n) => n.id)
}

export type NodeVisibility = 'normal' | 'dim' | 'hidden'

export interface ViewFilter {
  query: string
  selectedId: string | null
  depth: number
}

/**
 * Sichtbarkeit pro Knoten: der Knoten-Filter (Mockup „Knoten filtern …")
 * DIMMT Nicht-Treffer (Titel-Substring, case-insensitiv) statt sie zu
 * verstecken — Orientierung bleibt erhalten; die Tiefe (Mockup-Slider „Wie
 * viele Sprünge um die Auswahl herum gezeigt werden") VERSTECKT Knoten
 * jenseits der Sprungweite um die Auswahl, wirkt aber nur, wenn etwas
 * ausgewählt ist. Kanten folgen den Knoten (versteckt, sobald ein Ende
 * versteckt ist — das entscheidet die View, nicht dieses Modul).
 */
export function nodeVisibility(graph: GraphData, filter: ViewFilter): Map<string, NodeVisibility> {
  const result = new Map<string, NodeVisibility>(graph.nodes.map((n) => [n.id, 'normal']))

  if (filter.selectedId !== null && graph.nodes.some((n) => n.id === filter.selectedId)) {
    const adjacency = new Map<string, string[]>()
    for (const e of graph.edges) {
      ;(adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to)
      ;(adjacency.get(e.to) ?? adjacency.set(e.to, []).get(e.to)!).push(e.from)
    }
    const dist = new Map<string, number>([[filter.selectedId, 0]])
    const queue = [filter.selectedId]
    while (queue.length > 0) {
      const current = queue.shift()!
      const d = dist.get(current)!
      if (d >= filter.depth) continue
      for (const next of adjacency.get(current) ?? []) {
        if (!dist.has(next)) {
          dist.set(next, d + 1)
          queue.push(next)
        }
      }
    }
    for (const n of graph.nodes) {
      if (!dist.has(n.id)) result.set(n.id, 'hidden')
    }
  }

  const q = filter.query.trim().toLowerCase()
  if (q.length > 0) {
    for (const n of graph.nodes) {
      if (result.get(n.id) === 'normal' && !n.title.toLowerCase().includes(q)) {
        result.set(n.id, 'dim')
      }
    }
  }
  return result
}

/** Kantenzahl für die Hint-Zeile: nur eingeblendete Typen (Toggle) und nur
 *  Kanten, deren beide Enden nicht versteckt sind. `tag`-Kanten zählen nie
 *  (die UI zeigt die drei Mockup-Typen). */
export function visibleEdgeCount(
  graph: GraphData,
  visibility: ReadonlyMap<string, NodeVisibility>,
  hiddenTypes: ReadonlySet<string>,
): number {
  return graph.edges.filter(
    (e) =>
      e.type !== 'tag' &&
      !hiddenTypes.has(e.type) &&
      visibility.get(e.from) !== 'hidden' &&
      visibility.get(e.to) !== 'hidden',
  ).length
}

/** Legende-Wortlaute des abgenommenen Mockups (graph.html). */
export function statusLabel(status: GraphNodeStatus): string {
  switch (status) {
    case 'released': return 'Released'
    case 'review': return 'Review'
    case 'working': return 'Working'
    case 'archived': return 'Archiviert'
  }
}

/** Kürzt einen Knoten-Titel für das SVG-Label (`.lbl`, `graph-view.tsx`) auf
 *  höchstens `max` Zeichen (Ellipsis) — viele Seitentitel sind 30+ Zeichen
 *  lang und überlappen sonst benachbarte Knoten/fangen deren Klicks ab
 *  (Bugfix „Graph-Label-Overlap"). Der VOLLE Titel bleibt über `<title>`
 *  (nativer SVG-Tooltip) UND `aria-label` erreichbar — nur das sichtbare
 *  Label wird gekürzt, nicht die Zugänglichkeit. */
export function truncateLabel(title: string, max = 22): string {
  if (title.length <= max) return title
  return `${title.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}
