import type { ImportNode, ImportTree } from './model.js'

export interface FlatEntry { node: ImportNode; parent: ImportNode | null }

export function flattenTree(tree: ImportTree): FlatEntry[] {
  const out: FlatEntry[] = []
  const walk = (nodes: ImportNode[], parent: ImportNode | null) => {
    for (const node of [...nodes].sort((x, y) => x.order - y.order)) {
      out.push({ node, parent })
      walk(node.children, node)
    }
  }
  walk(tree.root, null)
  return out
}
