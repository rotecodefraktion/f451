/** Where a page came from. Written to the frontmatter as `source:` so a
 *  re-import can find the page again. */
export interface SourceRef {
  type: string
  id: string
  url?: string
  /** The import the page came from, so equal source ids of different sources
   *  stay apart. BookStack leaves it unset (the origin of `url` serves);
   *  file imports carry the upload's file name, stamped by the writer. */
  origin?: string
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
  /** Where the bytes came from. When the API refuses the upload, the writer
   *  points the Markdown reference back at this URL. */
  sourceUrl?: string
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
  /** File imports: frontmatter keys without an f451 equivalent, counted by key. */
  droppedFrontmatter?: Record<string, number>
  /** File imports: attachments no page references. */
  unreferenced?: string[]
  /** File imports: links whose target is not part of the import; they stay text. */
  unresolved?: Array<{ sourceId: string; target: string }>
  /** Obsidian: link targets matching several files; `chosen` is the path used. */
  ambiguous?: Array<{ sourceId: string; target: string; chosen: string }>
  /** Office imports: sheets cut at the row limit; `rows` is the sheet's row count. */
  truncated?: Array<{ sourceId: string; sheet: string; rows: number }>
  /** Notices that do not stop a page, e.g. `duplicateId` (an own ID another
   *  page took meanwhile). Set by the caller before writing. */
  warnings?: Array<{ sourceId: string; title: string; kind: string; detail: string }>
}

export interface ImportTarget {
  space: string
  parentId?: string
}

export interface ImportOptions {
  update: boolean
  release: boolean
  dryRun: boolean
  /** Checked between pages; an abort never interrupts a page in progress. */
  signal?: AbortSignal
  /** Origin for every node whose source has none of its own (neither
   *  `origin` nor a URL): the upload's file name of a file import. */
  origin?: string
  /** A `scanExisting` of the same target, made earlier by the caller; the
   *  writer then reads only the pages the scan has not. */
  existing?: ExistingScan
}

/** The target space as `scanExisting` found it. */
export interface ExistingScan {
  /** Every page of the space in tree order; `inSubtree` marks the pages below
   *  the target parent (all pages without one). */
  pages: Array<{ id: string; title: string; inSubtree: boolean }>
  /** Frontmatter source of each page read so far (every page in the
   *  subtree); null when it has none or could not be read. */
  sources: Map<string, SourceRef | null>
}

export type ImportEvent =
  | { kind: 'start'; pages: number }
  | {
      kind: 'page'
      sourceId: string
      title: string
      status: 'created' | 'updated' | 'skipped' | 'failed' | 'cancelled'
      pageId?: string
      reason?: string
    }
  | { kind: 'media'; sourceId: string; name: string; status: 'uploaded' | 'skipped'; reason?: string }
  /** Marks the start of a stretch without page events: `creating` (pass one),
   *  `writing` (pass two, page events follow). */
  | { kind: 'phase'; phase: string }
  | { kind: 'done' }
