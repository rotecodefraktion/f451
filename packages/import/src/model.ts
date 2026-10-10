/** Where a page came from. Written to the frontmatter as `source:` so a
 *  re-import can find the page again. */
export interface SourceRef {
  type: string
  id: string
  url?: string
}

export interface ImportMedia {
  /** File name inside `_media/` (already slugified by the adapter). */
  name: string
  bytes: Uint8Array
  mime: string
  kind: 'image' | 'file' | 'drawio'
  /** The URL or path the Markdown currently references; the writer rewrites
   *  it to the `_media/<name>` path the API returns. */
  ref: string
}

export interface ImportNode {
  sourceRef: SourceRef
  title: string
  /** CommonMark + GFM. Internal links are `[text](source:<id>|<url>)`
   *  placeholders until the writer knows the f451 ids. */
  markdown: string
  tags: string[]
  children: ImportNode[]
  media: ImportMedia[]
  /** Sort key among siblings, ascending. */
  order: number
  /** Set by the adapter when the source already carries an f451 id
   *  (BookStack tag `f451-id` written by the exporter). */
  knownF451Id?: string
}

export interface ImportTree {
  root: ImportNode[]
  /** Constructs that had no Markdown equivalent, counted by tag name. */
  droppedHtml: Record<string, number>
  /** Drawings that stayed PNG because no draw.io container was available. */
  drawingsAsPng: string[]
  /** Pages the adapter could not load or convert; they are not in `root`. */
  failed: Array<{ sourceId: string; title: string; reason: string }>
  /** Media the adapter did not download (too large, download failed). */
  mediaSkipped: Array<{ sourceId: string; name: string; reason: string }>
}

export interface ImportTarget {
  space: string
  parentId?: string
}

export interface ImportOptions {
  update: boolean
  release: boolean
  dryRun: boolean
}

export type ImportEvent =
  | { kind: 'start'; pages: number }
  | { kind: 'page'; sourceId: string; title: string; status: 'created' | 'updated' | 'skipped' | 'failed'; pageId?: string; reason?: string }
  | { kind: 'media'; sourceId: string; name: string; status: 'uploaded' | 'skipped'; reason?: string }
  | { kind: 'done' }
