/**
 * Options of the page picker (#175): the space tree flattened depth-first,
 * each entry with its depth for indentation. Archived pages are skipped
 * together with their subtree — they are no target for an import or export.
 *
 * Structural input type so `TreeNodeData` (`components/tree.tsx`) fits
 * without this module importing a component.
 */
export interface PickerNode {
  id: string
  title: string
  archived: boolean
  children: PickerNode[]
}

export interface PickerOption {
  id: string
  title: string
  depth: number
}

export function flattenTree(nodes: readonly PickerNode[], depth = 0): PickerOption[] {
  const out: PickerOption[] = []
  for (const node of nodes) {
    if (node.archived) continue
    out.push({ id: node.id, title: node.title, depth })
    out.push(...flattenTree(node.children, depth + 1))
  }
  return out
}
