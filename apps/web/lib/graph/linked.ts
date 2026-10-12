import type { GraphData, GraphEdge } from './types.js'

/** A page as the phone list shows it: id for the link, title for the label. */
export interface LinkedPage {
  id: string
  title: string
}

/** Outgoing links only: incoming ones are the backlinks section's job
 *  (`components/backlinks.tsx`, f451#97). */
export interface LinkedGroups {
  linksTo: LinkedPage[]
}

/** Edge types that make two pages "linked". Hierarchy and tags are structure,
 *  not references — the phone list leaves them out (f451#1). */
function isLinkEdge(edge: GraphEdge): boolean {
  return edge.type === 'link' || edge.type === 'relation'
}

function byTitle(a: LinkedPage, b: LinkedPage): number {
  return a.title.localeCompare(b.title)
}

/** Pages pageId links to over 'link' and 'relation' edges; incoming edges,
 *  hierarchy and tag ignored; self and duplicates removed; sorted by title
 *  (localeCompare). Targets missing from `graph.nodes` are skipped — there
 *  is no title to show for them. */
export function linkedPages(graph: GraphData, pageId: string): LinkedGroups {
  const titles = new Map(graph.nodes.map((n) => [n.id, n.title]))
  const linksTo = new Map<string, LinkedPage>()
  for (const edge of graph.edges) {
    if (!isLinkEdge(edge) || edge.from === edge.to || edge.from !== pageId) continue
    const title = titles.get(edge.to)
    if (title !== undefined) linksTo.set(edge.to, { id: edge.to, title })
  }
  return { linksTo: [...linksTo.values()].sort(byTitle) }
}

/** All pages with their number of distinct link/relation neighbours,
 *  descending, ties by title. */
export function pagesByConnections(graph: GraphData): Array<LinkedPage & { connections: number }> {
  const neighbours = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]))
  for (const edge of graph.edges) {
    if (!isLinkEdge(edge) || edge.from === edge.to) continue
    neighbours.get(edge.from)?.add(edge.to)
    neighbours.get(edge.to)?.add(edge.from)
  }
  return graph.nodes
    .map((n) => ({ id: n.id, title: n.title, connections: neighbours.get(n.id)?.size ?? 0 }))
    .sort((a, b) => b.connections - a.connections || byTitle(a, b))
}
