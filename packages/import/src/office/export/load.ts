// Loads the published pages of an Office export: the start page and, with
// subpages, its descendants in tree order, with the images they show.

import { parsePage } from '@f451/markdown'
import type { F451Api, TreeNode } from '../../api.js'
import { find } from '../../export/bookstack/tree.js'
import { isGalleryImage, mediaRefs } from '../../export/bookstack/media.js'
import { safeDecode } from './links.js'

export interface ExportPageSource {
  id: string
  title: string
  /** 0 = start page, 1 = its children, … */
  depth: number
  markdown: string
  /** Images of the page by the name the Markdown uses after `_media/`. Other
   *  attachments are not loaded; they become links. */
  media: Map<string, Uint8Array>
}

export type ExportF451Reader = Pick<F451Api, 'tree' | 'raw' | 'media'>

export class TooManyPagesError extends Error {
  constructor(
    readonly count: number,
    readonly max: number,
  ) {
    super(`the export has ${count} pages, more than ${max}`)
    this.name = 'TooManyPagesError'
  }
}

export class ExportPageNotFoundError extends Error {
  constructor(readonly pageId: string) {
    super(`page ${pageId} not found in the space tree`)
    this.name = 'ExportPageNotFoundError'
  }
}

const MEDIA_PREFIX = '_media/'

/** The start page and (with `subpages`) its non-archived descendants, depth first. */
export function exportNodes(
  roots: TreeNode[],
  pageId: string,
  subpages: boolean,
): Array<{ node: TreeNode; depth: number }> {
  const start = find(roots, pageId)
  if (!start) throw new ExportPageNotFoundError(pageId)
  const out: Array<{ node: TreeNode; depth: number }> = []
  const walk = (node: TreeNode, depth: number) => {
    out.push({ node, depth })
    if (!subpages) return
    for (const child of node.children) if (!child.archived) walk(child, depth + 1)
  }
  walk(start, 0)
  return out
}

/** Reads raw Markdown and images with `ref: 'main'` only: drafts never reach an export. */
export async function loadExportPages(
  f451: ExportF451Reader,
  opts: {
    space: string
    pageId: string
    subpages: boolean
    maxPages?: number
    /** The space tree when the caller already has it. */
    roots?: TreeNode[]
    /** Checked between pages. */
    signal?: AbortSignal
  },
): Promise<ExportPageSource[]> {
  const roots = opts.roots ?? (await f451.tree(opts.space))
  const nodes = exportNodes(roots, opts.pageId, opts.subpages)
  if (opts.maxPages !== undefined && nodes.length > opts.maxPages) {
    throw new TooManyPagesError(nodes.length, opts.maxPages)
  }
  const pages: ExportPageSource[] = []
  for (const { node, depth } of nodes) {
    opts.signal?.throwIfAborted()
    const markdown = await f451.raw(node.id)
    const media = new Map<string, Uint8Array>()
    for (const ref of mediaRefs(markdown)) {
      const name = ref.slice(MEDIA_PREFIX.length)
      if (!isGalleryImage(name) || media.has(name)) continue
      const bytes = await f451.media(node.id, safeDecode(name), 'main')
      if (bytes) media.set(name, bytes)
    }
    const title = parsePage(markdown).title?.trim() || node.title
    pages.push({ id: node.id, title, depth, markdown, media })
  }
  return pages
}
