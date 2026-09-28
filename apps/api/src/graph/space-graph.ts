import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { edges, pages, tags } from '../db/schema.js'

export const GRAPH_EDGE_TYPES = ['link', 'relation', 'hierarchy', 'tag'] as const
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number]

export interface GraphNode {
  id: string
  title: string
  path: string
  status: 'released' | 'working' | 'review' | 'archived'
  tags: string[]
  updatedAt: string
}

export interface GraphEdge {
  from: string
  to: string
  type: GraphEdgeType
  label: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Baut den Graphen eines Space vollständig aus dem Index (Spec §5): Knoten =
 * alle `ref='main'`-Seiten des Space; Kanten = materialisierte `edges`-Zeilen
 * der Typen link/relation/hierarchy (Broken Links — `toPageId IS NULL` —
 * erscheinen nie als Kante, sie sind Report-Daten) plus `tag`-Kanten, die
 * ZUR ABFRAGEZEIT berechnet werden (Spec §5: nicht materialisiert, sonst n²
 * bei beliebten Tags — hier bewusst als Paarbildung in JS über die geladenen
 * Tag-Zeilen des Space, ein Paar pro gemeinsamem Tag, Label = Tag).
 * Status ist hier ausschließlich Index-Wissen (released/archived) —
 * working/review reichert erst {@link applyWorkflowStatus} an (Rechte-Gate
 * liegt in der Route, nie hier).
 */
export async function buildSpaceGraph(
  db: Db,
  spaceId: string,
  types: readonly GraphEdgeType[],
): Promise<GraphData> {
  const pageRows = await db
    .select({ id: pages.id, title: pages.title, path: pages.path, archived: pages.archived, updatedAt: pages.updatedAt })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main')))

  const nodeIds = new Set(pageRows.map((r) => r.id))
  if (pageRows.length === 0) return { nodes: [], edges: [] }

  const tagRows = await db
    .select({ pageId: tags.pageId, tag: tags.tag })
    .from(tags)
    .where(and(inArray(tags.pageId, [...nodeIds]), eq(tags.ref, 'main')))

  const tagsByPage = new Map<string, string[]>()
  for (const r of tagRows) {
    const list = tagsByPage.get(r.pageId) ?? []
    list.push(r.tag)
    tagsByPage.set(r.pageId, list)
  }

  const nodes: GraphNode[] = pageRows
    .map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      status: (r.archived ? 'archived' : 'released') as GraphNode['status'],
      tags: (tagsByPage.get(r.id) ?? []).sort(),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const materialized = types.filter((t): t is Exclude<GraphEdgeType, 'tag'> => t !== 'tag')
  const edgeList: GraphEdge[] = []

  if (materialized.length > 0) {
    const edgeRows = await db
      .select({ from: edges.fromPageId, to: edges.toPageId, type: edges.type, label: edges.label })
      .from(edges)
      .where(and(eq(edges.ref, 'main'), isNotNull(edges.toPageId), inArray(edges.type, materialized)))
    for (const r of edgeRows) {
      // Beide Enden müssen Knoten dieses Space sein (edges trägt keinen
      // Space — der Join über die Knotenmenge filtert Fremd-Spaces).
      if (r.to !== null && nodeIds.has(r.from) && nodeIds.has(r.to)) {
        edgeList.push({ from: r.from, to: r.to, type: r.type as GraphEdgeType, label: r.label })
      }
    }
  }

  if (types.includes('tag')) {
    // Paarbildung pro Tag über die bereits geladenen Zeilen; Paar (a,b) mit
    // a<b, damit jede Verbindung genau einmal entsteht.
    const pagesByTag = new Map<string, string[]>()
    for (const r of tagRows) {
      const list = pagesByTag.get(r.tag) ?? []
      list.push(r.pageId)
      pagesByTag.set(r.tag, list)
    }
    for (const [tag, ids] of [...pagesByTag.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...new Set(ids)].sort()
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          edgeList.push({ from: sorted[i]!, to: sorted[j]!, type: 'tag', label: tag })
        }
      }
    }
  }

  // Deterministische Reihenfolge (stabil für Layout + Tests).
  edgeList.sort((a, b) =>
    a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label.localeCompare(b.label),
  )
  return { nodes, edges: edgeList }
}

/**
 * Nachbarschaft eines Knotens per BFS über UNGERICHTETE Adjazenz — eingehende
 * Kanten zählen ausdrücklich mit (Spec §5: „wer hängt von mir ab?"). Behalten
 * werden alle Knoten mit Abstand ≤ depth und alle Kanten, deren beide Enden
 * enthalten sind. Unbekanntes Zentrum → leerer Graph (die Route macht daraus
 * ihre 404 — hier keine Exception, reine Datenfunktion).
 */
export function neighborhood(graph: GraphData, centerId: string, depth: number): GraphData {
  if (!graph.nodes.some((n) => n.id === centerId)) return { nodes: [], edges: [] }
  const adjacency = new Map<string, string[]>()
  for (const e of graph.edges) {
    ;(adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to)
    ;(adjacency.get(e.to) ?? adjacency.set(e.to, []).get(e.to)!).push(e.from)
  }
  const dist = new Map<string, number>([[centerId, 0]])
  const queue = [centerId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const d = dist.get(current)!
    if (d >= depth) continue
    for (const next of adjacency.get(current) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, d + 1)
        queue.push(next)
      }
    }
  }
  return {
    nodes: graph.nodes.filter((n) => dist.has(n.id)),
    edges: graph.edges.filter((e) => dist.has(e.from) && dist.has(e.to)),
  }
}

/**
 * Reichert working/review an (Rechte-Gate liegt beim Aufrufer!). Vorrang:
 * archived > review > working > released — eine archivierte Seite bleibt
 * archiviert, auch wenn ein Entwurf existiert.
 */
export function applyWorkflowStatus(
  graph: GraphData,
  workingIds: ReadonlySet<string>,
  reviewIds: ReadonlySet<string>,
): GraphData {
  return {
    nodes: graph.nodes.map((n) => {
      if (n.status === 'archived') return n
      if (reviewIds.has(n.id)) return { ...n, status: 'review' as const }
      if (workingIds.has(n.id)) return { ...n, status: 'working' as const }
      return n
    }),
    edges: graph.edges,
  }
}
