import type { ImportMedia, ImportNode, ImportTree, SourceRef } from '../../model.js'
import { normalizeMarkdown } from '../../normalize.js'
import { BookStackNotFoundError, type BookStackClient } from './client.js'
import { convertDrawings, type DrawioRenderer } from './drawings.js'
import { htmlToMarkdown, type ConversionContext } from './html-to-md.js'
import { collectMedia } from './media.js'
import { publicBaseOf } from './public-base.js'
import type { BookStackBookContents, BookStackTag } from './types.js'
import { trimTrailingSlashes } from '../../url.js'

export interface BookStackSelector {
  shelf?: string
  book?: string
  /** A numeric page id (BookStack has no global page slug). */
  page?: string
}

export interface BookStackLoadOptions {
  baseUrl: string
  drawio: DrawioRenderer | null
  maxBytes: number
  /** Stops loading between items; see `loadBookStackTree`. */
  signal?: AbortSignal
}

interface PageEntry {
  id: number
  slug: string
  bookSlug: string
  url: string
}

/** What gets imported, collected before any page is fetched so internal links
 *  can be resolved against the whole scope. */
type Plan =
  | {
      kind: 'folder'
      sourceRef: SourceRef
      title: string
      html: string
      tags: BookStackTag[]
      order: number
      children: Plan[]
    }
  | { kind: 'page'; id: number; order: number }

class PageIndex {
  private readonly byId = new Map<number, PageEntry>()
  private readonly byPath = new Map<string, PageEntry>()
  /** The configured base URL and every public base seen in reported URLs. */
  private readonly bases: Set<string>

  constructor(private readonly baseUrl: string) {
    this.bases = new Set([baseUrl])
  }

  /** `url` is the page URL BookStack reports, if any; else it is built from
   *  the base URL. A reported URL also teaches the index BookStack's public
   *  base, so absolute links written with it count as internal. */
  add(id: number, slug: string, bookSlug: string, url?: string): void {
    const entry = { id, slug, bookSlug, url: url ?? pageUrl(this.baseUrl, bookSlug, slug) }
    const publicBase = publicBaseOf(url)
    if (publicBase) this.bases.add(publicBase)
    this.byId.set(id, entry)
    this.byPath.set(`${bookSlug}/${slug}`, entry)
  }

  url(id: number): string | undefined {
    return this.byId.get(id)?.url
  }

  /** Bases learned from reported URLs, other than the configured one. */
  publicBases(): string[] {
    return [...this.bases].filter((b) => b !== this.baseUrl)
  }

  resolve(href: string): { id: string; url: string } | null {
    let path = href
    for (const base of this.bases) {
      if (path.startsWith(`${base}/`)) {
        path = path.slice(base.length)
        break
      }
    }
    path = path.split(/[?#]/)[0] ?? ''
    const link = /^\/link\/(\d+)\/?$/.exec(path)
    if (link) return toTarget(this.byId.get(Number(link[1])))
    const page = /^\/books\/([^/]+)\/page\/([^/]+)\/?$/.exec(path)
    if (page) return toTarget(this.byPath.get(`${decode(page[1]!)}/${decode(page[2]!)}`))
    return null
  }
}

function toTarget(entry: PageEntry | undefined): { id: string; url: string } | null {
  return entry ? { id: String(entry.id), url: entry.url } : null
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function pageUrl(baseUrl: string, bookSlug: string, slug: string): string {
  return `${baseUrl}/books/${bookSlug}/page/${slug}`
}

/** The `url` BookStack puts on an item (built from its own APP_URL, so
 *  reachable for readers even when f451 uses an internal base URL), or
 *  undefined when the response carries none. */
function reportedUrl(item: unknown): string | undefined {
  const url = (item as { url?: unknown } | null)?.url
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** The contents entry of a page in a book (top level or inside a chapter). */
function findPageItem(book: BookStackBookContents, id: number): unknown {
  for (const item of book.contents ?? []) {
    if (item.type === 'page' && item.id === id) return item
    const page = item.pages?.find((p) => p.id === id)
    if (page) return page
  }
  return undefined
}

/** shelf → folder page → books; book → folder page; chapter → folder page;
 *  page → page. The description of a shelf/book/chapter is its body.
 *
 *  Cancelling: the selector is always resolved. After that `opts.signal` is
 *  checked before each book, chapter and page is loaded — never in the middle
 *  of one. Once it is aborted nothing more is loaded or built: the tree holds
 *  only the nodes finished so far (a folder being built keeps the children it
 *  already has), and the caller's `importTree` reports them as cancelled. */
export async function loadBookStackTree(
  client: BookStackClient,
  selector: BookStackSelector,
  opts: BookStackLoadOptions,
): Promise<ImportTree> {
  const baseUrl = trimTrailingSlashes(opts.baseUrl)
  const index = new PageIndex(baseUrl)
  const aborted = () => opts.signal?.aborted === true
  const plans = await planScope(client, selector, baseUrl, index, aborted)

  const tree: ImportTree = { root: [], droppedHtml: {}, drawingsAsPng: [], failed: [], mediaSkipped: [] }
  // Planning has registered every page, so the public bases are known by now.
  const ctx: ConversionContext = {
    baseUrl,
    publicBases: index.publicBases(),
    resolveInternalLink: (href) => index.resolve(href),
  }
  // A page that cannot be loaded or converted is a page error: it is recorded
  // and left out, the rest of the tree is still imported.
  const build = async (plan: Plan): Promise<ImportNode | null> => {
    if (aborted()) return null
    if (plan.kind === 'folder') return buildFolder(plan, ctx, tree, build)
    try {
      return await buildPage(client, plan, ctx, index, { ...opts, baseUrl }, tree)
    } catch (e) {
      tree.failed.push({ sourceId: String(plan.id), title: `page ${plan.id}`, reason: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  for (const plan of plans) {
    const node = await build(plan)
    if (node) tree.root.push(node)
  }
  return tree
}

async function planScope(
  client: BookStackClient,
  selector: BookStackSelector,
  baseUrl: string,
  index: PageIndex,
  aborted: () => boolean,
): Promise<Plan[]> {
  if (selector.page !== undefined) {
    if (!/^\d+$/.test(selector.page)) throw new Error(`page not found: ${selector.page} (expected a numeric id)`)
    const id = Number(selector.page)
    const page = await notFoundAs(`page not found: ${selector.page}`, () => client.getPage(id))
    const book = await client.getBookContents(page.book_id)
    index.add(page.id, page.slug, book.slug, reportedUrl(page) ?? reportedUrl(findPageItem(book, page.id)))
    return [{ kind: 'page', id: page.id, order: page.priority }]
  }

  if (selector.book !== undefined) {
    const id = await resolveId(client, 'books', selector.book, 'book')
    const book = await notFoundAs(`book not found: ${selector.book}`, () => client.getBookContents(id))
    return [await planBook(client, book, 0, baseUrl, index, aborted)]
  }

  if (selector.shelf !== undefined) {
    const id = await resolveId(client, 'shelves', selector.shelf, 'shelf')
    const shelf = await notFoundAs(`shelf not found: ${selector.shelf}`, () => client.getShelf(id))
    const children: Plan[] = []
    for (const [i, b] of (shelf.books ?? []).entries()) {
      if (aborted()) break
      const book = await client.getBookContents(b.id)
      children.push(await planBook(client, book, i, baseUrl, index, aborted))
    }
    return [
      {
        kind: 'folder',
        sourceRef: { type: 'bookstack', id: `shelf:${shelf.id}`, url: reportedUrl(shelf) ?? `${baseUrl}/shelves/${shelf.slug}` },
        title: shelf.name,
        html: shelf.description_html ?? shelf.description ?? '',
        tags: shelf.tags ?? [],
        order: 0,
        children,
      },
    ]
  }

  throw new Error('nothing selected: pass a shelf, a book or a page')
}

async function planBook(
  client: BookStackClient,
  book: BookStackBookContents,
  order: number,
  baseUrl: string,
  index: PageIndex,
  aborted: () => boolean,
): Promise<Plan> {
  const children: Plan[] = []
  for (const item of book.contents ?? []) {
    if (aborted()) break
    if (item.type === 'page') {
      if (item.draft) continue
      index.add(item.id, item.slug, book.slug, reportedUrl(item))
      children.push({ kind: 'page', id: item.id, order: item.priority })
      continue
    }
    // The contents listing carries no chapter description; fetch the chapter.
    const chapter = await client.getChapter(item.id)
    const pages: Plan[] = []
    for (const p of item.pages ?? []) {
      if (p.draft) continue
      index.add(p.id, p.slug, book.slug, reportedUrl(p))
      pages.push({ kind: 'page', id: p.id, order: p.priority })
    }
    children.push({
      kind: 'folder',
      sourceRef: { type: 'bookstack', id: `chapter:${item.id}`, url: reportedUrl(item) ?? reportedUrl(chapter) ?? `${baseUrl}/books/${book.slug}/chapter/${item.slug}` },
      title: chapter.name,
      html: chapter.description_html ?? chapter.description ?? '',
      tags: chapter.tags ?? [],
      order: item.priority,
      children: pages,
    })
  }
  return {
    kind: 'folder',
    sourceRef: { type: 'bookstack', id: `book:${book.id}`, url: reportedUrl(book) ?? `${baseUrl}/books/${book.slug}` },
    title: book.name,
    html: book.description_html ?? book.description ?? '',
    tags: book.tags ?? [],
    order,
    children,
  }
}

async function resolveId(
  client: BookStackClient,
  kind: 'books' | 'shelves',
  value: string,
  label: string,
): Promise<number> {
  if (/^\d+$/.test(value)) return Number(value)
  const id = await client.findBySlug(kind, value)
  if (id === null) throw new Error(`${label} not found: ${value}`)
  return id
}

async function notFoundAs<T>(message: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (error instanceof BookStackNotFoundError) throw new Error(message, { cause: error })
    throw error
  }
}

async function buildPage(
  client: BookStackClient,
  plan: { id: number; order: number },
  ctx: ConversionContext,
  index: PageIndex,
  opts: BookStackLoadOptions,
  tree: ImportTree,
): Promise<ImportNode> {
  const page = await client.getPage(plan.id)
  const converted = htmlToMarkdown(page.html ?? '', ctx)
  mergeCounts(tree.droppedHtml, converted.dropped)

  // Media before normalising: turndown keeps `src` verbatim, so a file name
  // with a space is not a valid Markdown destination until it is rewritten.
  const usedNames = new Set<string>()
  const drawings = await convertDrawings(converted.drawings, converted.markdown, client, {
    baseUrl: opts.baseUrl,
    drawio: opts.drawio,
    usedNames,
  })
  tree.drawingsAsPng.push(...drawings.asPng)
  for (const m of drawings.skipped) tree.mediaSkipped.push({ sourceId: String(page.id), ...m })
  const collected = await collectMedia(drawings.markdown, client, page.id, {
    baseUrl: opts.baseUrl,
    maxBytes: opts.maxBytes,
    usedNames,
  })

  for (const m of collected.skipped) tree.mediaSkipped.push({ sourceId: String(page.id), ...m })

  const normalized = normalizeMarkdown(`# ${page.name}\n\n${collected.markdown}`)
  mergeCounts(tree.droppedHtml, normalized.dropped)

  const media: ImportMedia[] = [...drawings.media, ...collected.media]
  const { tags, knownF451Id } = mapTags(page.tags ?? [])
  const node: ImportNode = {
    sourceRef: { type: 'bookstack', id: String(page.id), url: index.url(page.id) ?? reportedUrl(page) ?? `${opts.baseUrl}/link/${page.id}` },
    title: page.name,
    markdown: normalized.markdown,
    tags,
    children: [],
    media,
    order: plan.order,
  }
  if (knownF451Id) node.knownF451Id = knownF451Id
  return node
}

async function buildFolder(
  plan: Extract<Plan, { kind: 'folder' }>,
  ctx: ConversionContext,
  tree: ImportTree,
  build: (plan: Plan) => Promise<ImportNode | null>,
): Promise<ImportNode> {
  const converted = htmlToMarkdown(plan.html, ctx)
  mergeCounts(tree.droppedHtml, converted.dropped)
  const normalized = normalizeMarkdown(`# ${plan.title}\n\n${converted.markdown}`)
  mergeCounts(tree.droppedHtml, normalized.dropped)

  const children: ImportNode[] = []
  for (const child of [...plan.children].sort((a, b) => a.order - b.order)) {
    const node = await build(child)
    if (node) children.push(node)
  }

  const { tags, knownF451Id } = mapTags(plan.tags)
  const node: ImportNode = {
    sourceRef: plan.sourceRef,
    title: plan.title,
    markdown: normalized.markdown,
    tags,
    children,
    media: [],
    order: plan.order,
  }
  if (knownF451Id) node.knownF451Id = knownF451Id
  return node
}

/** `name:value` (or `name`), except the exporter's `f451-id`/`f451-space`. */
function mapTags(source: BookStackTag[]): { tags: string[]; knownF451Id?: string } {
  const tags: string[] = []
  let knownF451Id: string | undefined
  for (const t of source) {
    if (t.name === 'f451-id') {
      if (t.value) knownF451Id = t.value
      continue
    }
    if (t.name === 'f451-space') continue
    tags.push(t.value ? `${t.name}:${t.value}` : t.name)
  }
  return { tags, knownF451Id }
}

function mergeCounts(target: Record<string, number>, add: Record<string, number>): void {
  for (const [k, n] of Object.entries(add)) target[k] = (target[k] ?? 0) + n
}
