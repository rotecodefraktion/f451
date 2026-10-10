import type { TreeNode } from '../../api.js'

export interface ExportPage { pageId: string; name: string; priority: number }
export interface ExportChapter { pageId: string; name: string; priority: number; pages: ExportPage[] }
export interface ExportBook { name: string; rootPageId: string | null; chapters: ExportChapter[]; pages: ExportPage[] }

const SEPARATOR = ' / '
const ROOT_PATH = 'index.md'

const visible = (nodes: TreeNode[]): TreeNode[] => nodes.filter((n) => !n.archived)

function find(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = find(n.children, id)
    if (hit) return hit
  }
  return null
}

/** The space root page and the top-level nodes. The tree API returns either the root page
 *  `index.md` as a root whose children are the top level, or a flat list of roots that may
 *  contain the (childless) root page next to the top-level pages. Both shapes are accepted. */
function splitSpace(roots: TreeNode[]): { root: TreeNode | null; top: TreeNode[] } {
  const root = roots.find((n) => n.path === ROOT_PATH) ?? null
  if (!root) return { root: null, top: roots }
  const others = roots.filter((n) => n !== root)
  return { root, top: [...root.children, ...others] }
}

/** Depth-first: `node` itself, then its descendants with the path as name prefix. */
function flatten(node: TreeNode, prefix: string, out: ExportPage[]): void {
  const name = prefix ? `${prefix}${SEPARATOR}${node.title}` : node.title
  out.push({ pageId: node.id, name, priority: out.length * 10 })
  for (const child of visible(node.children)) flatten(child, name, out)
}

function chapter(node: TreeNode, priority: number): ExportChapter {
  // The chapter's own content is its first page, named like the chapter (priority 0).
  const pages: ExportPage[] = [{ pageId: node.id, name: node.title, priority: 0 }]
  for (const child of visible(node.children)) flatten(child, '', pages)
  return { pageId: node.id, name: node.title, priority, pages }
}

/** Book from the root page (may be null) and the top-level nodes: folders become chapters,
 *  leaves become book pages. Book pages and chapters share one priority sequence. */
function build(bookName: string, root: TreeNode | null, top: TreeNode[]): ExportBook {
  const book: ExportBook = { name: bookName, rootPageId: root?.id ?? null, chapters: [], pages: [] }
  let position = 0
  if (root && !root.archived) book.pages.push({ pageId: root.id, name: root.title, priority: position++ * 10 })
  for (const node of visible(top)) {
    const priority = position++ * 10
    if (visible(node.children).length > 0) book.chapters.push(chapter(node, priority))
    else book.pages.push({ pageId: node.id, name: node.title, priority })
  }
  return book
}

export function planBook(roots: TreeNode[], opts: { bookName: string; startPageId?: string }): ExportBook {
  if (opts.startPageId !== undefined) {
    const start = find(roots, opts.startPageId)
    if (!start) throw new Error(`start page ${opts.startPageId} not found in the tree`)
    return build(opts.bookName, start, start.children)
  }
  const { root, top } = splitSpace(roots)
  return build(opts.bookName, root, top)
}
