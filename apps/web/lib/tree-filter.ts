/**
 * Filter field of the page tree (`components/tree-filter.tsx`): which nodes
 * stay visible for a given query. Pure logic, no DOM — the island applies the
 * result to the server-rendered tree.
 */

/** A tree node as far as filtering is concerned (structurally compatible with
 *  `TreeNodeData` from `components/tree.tsx`). */
export interface FilterNode {
  id: string
  title: string
  children: readonly FilterNode[]
}

/** Case- and diacritics-insensitive form: `Übersicht` and `ubersicht` fold to
 *  the same string, so typing without umlauts still finds the page. */
export function foldForFilter(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('de')
}

/**
 * Ids of the nodes to show for `query`: every node whose title contains the
 * query, plus all of its ancestors (otherwise the match would sit in a hidden
 * branch). `null` for an empty or whitespace-only query — show everything.
 * No match yields an empty set, not `null`.
 */
export function filterTree(nodes: readonly FilterNode[], query: string): Set<string> | null {
  const needle = foldForFilter(query.trim())
  if (needle === '') return null

  const visible = new Set<string>()
  // Returns whether `node` or one of its descendants matches.
  const visit = (node: FilterNode): boolean => {
    let keep = foldForFilter(node.title).includes(needle)
    for (const child of node.children) {
      if (visit(child)) keep = true
    }
    if (keep) visible.add(node.id)
    return keep
  }
  for (const node of nodes) visit(node)
  return visible
}

/** Strips the tree to what the filter needs — the shape that crosses the
 *  server/client boundary to the island. */
export function toFilterNodes(nodes: readonly FilterNode[]): FilterNode[] {
  return nodes.map((node) => ({ id: node.id, title: node.title, children: toFilterNodes(node.children) }))
}
