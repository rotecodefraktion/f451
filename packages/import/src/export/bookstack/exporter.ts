import { parsePage } from '@f451/markdown'
import type { F451Api, TreeNode } from '../../api.js'
import type { BookStackClient } from '../../adapters/bookstack/client.js'
import type { BookStackTag } from '../../adapters/bookstack/types.js'
import { planBook, type ExportPage } from './tree.js'
import { pageResolver, renderForBookStack, type HtmlContext } from './html.js'
import { isGalleryImage, mediaRefs, uploadAttachments, uploadImages } from './media.js'
import { emptyExportReport, type ExportReport } from './report.js'

export interface ExportOptions {
  space: string
  startPageId?: string
  bookId?: number
  dryRun: boolean
  /** Absolute f451 base URL, for links to pages outside the export. */
  f451Url: string
  /** BookStack base URL, for links between exported pages. */
  bookstackUrl: string
}

export type ExportEvent =
  | { kind: 'start'; pages: number }
  | {
      kind: 'page'
      pageId: string
      name: string
      /** `rendered` only in a dry run. */
      status: 'created' | 'updated' | 'rendered' | 'failed'
      bsId?: number
      reason?: string
    }
  | { kind: 'done' }

export type ExportF451 = Pick<F451Api, 'tree' | 'raw' | 'media'>
export type ExportBookStack = Pick<
  BookStackClient,
  | 'searchByTag'
  | 'getBookContents'
  | 'createBook'
  | 'updateBook'
  | 'createChapter'
  | 'updateChapter'
  | 'getPage'
  | 'createPage'
  | 'updatePage'
  | 'listGalleryImages'
  | 'uploadImage'
  | 'uploadAttachment'
  | 'getAttachmentsForPage'
>

const ID_TAG = 'f451-id'
const SPACE_TAG = 'f451-space'
const MEDIA_PREFIX = '_media/'
const PLACEHOLDER_HTML = '<p>…</p>'

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** A planned page with its Markdown loaded and its final BookStack name. */
interface LoadedPage {
  page: ExportPage
  chapterPageId: string | null
  markdown: string
  name: string
}

interface PlacedPage extends LoadedPage {
  bsId: number
  isNew: boolean
}

function mimeOf(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function titles(nodes: TreeNode[], out = new Map<string, string>()): Map<string, string> {
  for (const n of nodes) {
    out.set(n.id, n.title)
    titles(n.children, out)
  }
  return out
}

/** The planned name carries the path prefix (`B / C`) built from tree titles; the last
 *  segment is replaced by the page's own title from the Markdown (frontmatter `title:`). */
function pageName(planned: string, treeTitle: string | undefined, markdown: string): string {
  const title = parsePage(markdown).title?.trim()
  if (!title || treeTitle === undefined || !planned.endsWith(treeTitle)) return planned
  return planned.slice(0, planned.length - treeTitle.length) + title
}

function tagsFor(f451Id: string, space: string): BookStackTag[] {
  return [
    { name: ID_TAG, value: f451Id },
    { name: SPACE_TAG, value: space },
  ]
}

async function findByTag(
  bs: ExportBookStack,
  f451Id: string,
  type: 'book' | 'chapter' | 'page',
): Promise<{ id: number; name: string } | null> {
  return (await bs.searchByTag(ID_TAG, f451Id)).find((h) => h.type === type) ?? null
}

async function resolveBook(
  bs: ExportBookStack,
  name: string,
  f451Id: string,
  opts: ExportOptions,
): Promise<{ id: number; slug: string }> {
  if (opts.bookId !== undefined) {
    const b = await bs.getBookContents(opts.bookId)
    return { id: b.id, slug: b.slug }
  }
  const hit = await findByTag(bs, f451Id, 'book')
  if (!hit) {
    const b = await bs.createBook({ name, tags: tagsFor(f451Id, opts.space) })
    return { id: b.id, slug: b.slug }
  }
  if (hit.name !== name) {
    const b = await bs.updateBook(hit.id, { name })
    return { id: b.id, slug: b.slug }
  }
  const b = await bs.getBookContents(hit.id)
  return { id: b.id, slug: b.slug }
}

/** Exports an f451 space (or the subtree under `startPageId`) to one BookStack book.
 *  Never writes to f451. Pages are matched by their `f451-id` tag, so a second run
 *  updates in place. BookStack pages no longer in the export are reported, never deleted. */
export async function exportToBookStack(
  f451: ExportF451,
  bs: ExportBookStack,
  opts: ExportOptions,
  onEvent: (e: ExportEvent) => void,
): Promise<ExportReport> {
  const report = emptyExportReport()
  const fail = (pageId: string, name: string, err: unknown, bsId?: number) => {
    const reason = reasonOf(err)
    report.failed.push({ pageId, name, reason })
    onEvent({ kind: 'page', pageId, name, status: 'failed', reason, ...(bsId !== undefined ? { bsId } : {}) })
  }

  // 1. Plan the book from the f451 tree.
  const roots = await f451.tree(opts.space)
  const treeTitles = titles(roots)
  const bookName =
    opts.startPageId !== undefined ? (treeTitles.get(opts.startPageId) ?? opts.space) : opts.space
  const book = planBook(roots, { bookName, startPageId: opts.startPageId })
  const entries: Array<{ page: ExportPage; chapterPageId: string | null }> = [
    ...book.pages.map((page) => ({ page, chapterPageId: null })),
    ...book.chapters.flatMap((c) => c.pages.map((page) => ({ page, chapterPageId: c.pageId }))),
  ]
  onEvent({ kind: 'start', pages: entries.length })

  const ctx: HtmlContext = {
    bookstackUrls: new Map(),
    f451Url: opts.f451Url,
    space: opts.space,
    imageUrls: new Map(),
    attachmentUrls: new Map(),
    resolvePage: pageResolver(roots),
  }

  // Load every page's Markdown once; the final name depends on it.
  const loaded: LoadedPage[] = []
  for (const e of entries) {
    try {
      const markdown = await f451.raw(e.page.pageId)
      loaded.push({ ...e, markdown, name: pageName(e.page.name, treeTitles.get(e.page.pageId), markdown) })
    } catch (err) {
      fail(e.page.pageId, e.page.name, err)
    }
  }

  // Dry run: render only, no BookStack request at all; links fall back to f451 URLs.
  if (opts.dryRun) {
    report.dryRunPages = []
    for (const p of loaded) {
      try {
        const { html, brokenLinks } = renderForBookStack(p.markdown, p.page.pageId, ctx)
        report.brokenLinks += brokenLinks
        report.dryRunPages.push({ pageId: p.page.pageId, name: p.name, html })
        onEvent({ kind: 'page', pageId: p.page.pageId, name: p.name, status: 'rendered' })
      } catch (err) {
        fail(p.page.pageId, p.name, err)
      }
    }
    onEvent({ kind: 'done' })
    return report
  }

  // 2. Target book.
  const target = await resolveBook(bs, book.name, book.rootPageId ?? `space:${opts.space}`, opts)
  const base = opts.bookstackUrl.replace(/\/+$/, '')

  // 3. Chapters.
  const chapterIds = new Map<string, number>()
  for (const c of book.chapters) {
    const hit = await findByTag(bs, c.pageId, 'chapter')
    if (hit) {
      await bs.updateChapter(hit.id, { name: c.name, priority: c.priority })
      chapterIds.set(c.pageId, hit.id)
    } else {
      const created = await bs.createChapter({
        book_id: target.id,
        name: c.name,
        priority: c.priority,
        tags: tagsFor(c.pageId, opts.space),
      })
      chapterIds.set(c.pageId, created.id)
    }
  }

  // 4. Pass one: every page gets its BookStack id and final slug (name and place are set
  //    here already, so the URLs collected for links do not change in pass two).
  const placed: PlacedPage[] = []
  const touched = new Set<number>()
  for (const p of loaded) {
    try {
      const location =
        p.chapterPageId !== null ? { chapter_id: chapterIds.get(p.chapterPageId)! } : { book_id: target.id }
      const hit = await findByTag(bs, p.page.pageId, 'page')
      const bsPage = hit
        ? await bs.updatePage(hit.id, { name: p.name, priority: p.page.priority, ...location })
        : await bs.createPage({
            name: p.name,
            html: PLACEHOLDER_HTML,
            priority: p.page.priority,
            ...location,
            tags: tagsFor(p.page.pageId, opts.space),
          })
      ctx.bookstackUrls.set(p.page.pageId, `${base}/books/${target.slug}/page/${bsPage.slug}`)
      placed.push({ ...p, bsId: bsPage.id, isNew: !hit })
      touched.add(bsPage.id)
    } catch (err) {
      fail(p.page.pageId, p.name, err)
    }
  }

  // 5. Pass two: media, HTML, content.
  for (const p of placed) {
    try {
      const images: Array<{ name: string; bytes: Uint8Array }> = []
      const attachments: Array<{ name: string; bytes: Uint8Array; mime: string }> = []
      for (const ref of mediaRefs(p.markdown)) {
        const name = ref.slice(MEDIA_PREFIX.length)
        const bytes = await f451.media(p.page.pageId, name, 'main')
        if (!bytes) {
          report.missingMedia.push({ pageId: p.page.pageId, ref })
          continue
        }
        if (isGalleryImage(name)) images.push({ name, bytes })
        else attachments.push({ name, bytes, mime: mimeOf(name) })
      }
      const byName = await uploadImages(bs, p.bsId, images)
      const attachmentByName = await uploadAttachments(bs, p.bsId, attachments, opts.bookstackUrl)
      const imageUrls = new Map([...byName].map(([name, url]) => [`${MEDIA_PREFIX}${name}`, url] as const))
      const attachmentUrls = new Map([...attachmentByName].map(([name, url]) => [`${MEDIA_PREFIX}${name}`, url] as const))

      const { html, brokenLinks } = renderForBookStack(p.markdown, p.page.pageId, { ...ctx, imageUrls, attachmentUrls })
      await bs.updatePage(p.bsId, { name: p.name, html })

      report.brokenLinks += brokenLinks
      const row = { pageId: p.page.pageId, name: p.name, bsId: p.bsId }
      if (p.isNew) report.created.push(row)
      else report.updated.push(row)
      onEvent({ kind: 'page', ...row, status: p.isNew ? 'created' : 'updated' })
    } catch (err) {
      fail(p.page.pageId, p.name, err, p.bsId)
    }
  }

  // 6. Stale: pages of the target book tagged with this space whose f451 id is not planned.
  const planned = new Set(entries.map((e) => e.page.pageId))
  for (const hit of await bs.searchByTag(SPACE_TAG, opts.space)) {
    if (hit.type !== 'page' || touched.has(hit.id)) continue
    const page = await bs.getPage(hit.id)
    if (page.book_id !== target.id) continue
    const f451Id = page.tags?.find((t) => t.name === ID_TAG)?.value
    if (f451Id !== undefined && planned.has(f451Id)) continue
    report.stale.push({ bsId: hit.id, name: hit.name })
  }

  onEvent({ kind: 'done' })
  return report
}
