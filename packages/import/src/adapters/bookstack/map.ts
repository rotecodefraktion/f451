import type { ImportMedia, ImportNode, ImportTree, SourceRef } from '../../model.js'
import { normalizeMarkdown } from '../../normalize.js'
import { BookStackNotFoundError, type BookStackClient } from './client.js'
import { convertDrawings, type DrawioRenderer } from './drawings.js'
import { htmlToMarkdown, type ConversionContext } from './html-to-md.js'
import { collectMedia } from './media.js'
import type { BookStackBookContents, BookStackTag } from './types.js'

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

  constructor(private readonly baseUrl: string) {}

  add(id: number, slug: string, bookSlug: string): void {
    const entry = { id, slug, bookSlug, url: pageUrl(this.baseUrl, bookSlug, slug) }
    this.byId.set(id, entry)
    this.byPath.set(`${bookSlug}/${slug}`, entry)
  }

  url(id: number): string | undefined {
    return this.byId.get(id)?.url
  }

  resolve(href: string): { id: string; url: string } | null {
    let path = href
    if (path.startsWith(`${this.baseUrl}/`)) path = path.slice(this.baseUrl.length)
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

/** shelf → folder page → books; book → folder page; chapter → folder page;
 *  page → page. The description of a shelf/book/chapter is its body. */
export async function loadBookStackTree(
  client: BookStackClient,
  selector: BookStackSelector,
  opts: BookStackLoadOptions,
): Promise<ImportTree> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const index = new PageIndex(baseUrl)
  const plans = await planScope(client, selector, baseUrl, index)

  const tree: ImportTree = { root: [], droppedHtml: {}, drawingsAsPng: [] }
  const ctx: ConversionContext = { baseUrl, resolveInternalLink: (href) => index.resolve(href) }
  const build = async (plan: Plan): Promise<ImportNode> =>
    plan.kind === 'page'
      ? buildPage(client, plan, ctx, index, { ...opts, baseUrl }, tree)
      : buildFolder(plan, ctx, tree, build)

  for (const plan of plans) tree.root.push(await build(plan))
  return tree
}

async function planScope(
  client: BookStackClient,
  selector: BookStackSelector,
  baseUrl: string,
  index: PageIndex,
): Promise<Plan[]> {
  if (selector.page !== undefined) {
    if (!/^\d+$/.test(selector.page)) throw new Error(`page not found: ${selector.page} (expected a numeric id)`)
    const id = Number(selector.page)
    const page = await notFoundAs(`page not found: ${selector.page}`, () => client.getPage(id))
    const book = await client.getBookContents(page.book_id)
    index.add(page.id, page.slug, book.slug)
    return [{ kind: 'page', id: page.id, order: page.priority }]
  }

  if (selector.book !== undefined) {
    const id = await resolveId(client, 'books', selector.book, 'book')
    const book = await notFoundAs(`book not found: ${selector.book}`, () => client.getBookContents(id))
    return [await planBook(client, book, 0, baseUrl, index)]
  }

  if (selector.shelf !== undefined) {
    const id = await resolveId(client, 'shelves', selector.shelf, 'shelf')
    const shelf = await notFoundAs(`shelf not found: ${selector.shelf}`, () => client.getShelf(id))
    const children: Plan[] = []
    for (const [i, b] of (shelf.books ?? []).entries()) {
      const book = await client.getBookContents(b.id)
      children.push(await planBook(client, book, i, baseUrl, index))
    }
    return [
      {
        kind: 'folder',
        sourceRef: { type: 'bookstack', id: `shelf:${shelf.id}`, url: `${baseUrl}/shelves/${shelf.slug}` },
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
): Promise<Plan> {
  const children: Plan[] = []
  for (const item of book.contents ?? []) {
    if (item.type === 'page') {
      if (item.draft) continue
      index.add(item.id, item.slug, book.slug)
      children.push({ kind: 'page', id: item.id, order: item.priority })
      continue
    }
    // The contents listing carries no chapter description; fetch the chapter.
    const chapter = await client.getChapter(item.id)
    const pages: Plan[] = []
    for (const p of item.pages ?? []) {
      if (p.draft) continue
      index.add(p.id, p.slug, book.slug)
      pages.push({ kind: 'page', id: p.id, order: p.priority })
    }
    children.push({
      kind: 'folder',
      sourceRef: { type: 'bookstack', id: `chapter:${item.id}`, url: `${baseUrl}/books/${book.slug}/chapter/${item.slug}` },
      title: chapter.name,
      html: chapter.description_html ?? chapter.description ?? '',
      tags: chapter.tags ?? [],
      order: item.priority,
      children: pages,
    })
  }
  return {
    kind: 'folder',
    sourceRef: { type: 'bookstack', id: `book:${book.id}`, url: `${baseUrl}/books/${book.slug}` },
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
  const collected = await collectMedia(drawings.markdown, client, page.id, {
    baseUrl: opts.baseUrl,
    maxBytes: opts.maxBytes,
    usedNames,
  })

  const normalized = normalizeMarkdown(`# ${page.name}\n\n${collected.markdown}`)
  mergeCounts(tree.droppedHtml, normalized.dropped)

  const media: ImportMedia[] = [...drawings.media, ...collected.media]
  const { tags, knownF451Id } = mapTags(page.tags ?? [])
  const node: ImportNode = {
    sourceRef: { type: 'bookstack', id: String(page.id), url: index.url(page.id) ?? `${opts.baseUrl}/link/${page.id}` },
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
  build: (plan: Plan) => Promise<ImportNode>,
): Promise<ImportNode> {
  const converted = htmlToMarkdown(plan.html, ctx)
  mergeCounts(tree.droppedHtml, converted.dropped)
  const normalized = normalizeMarkdown(`# ${plan.title}\n\n${converted.markdown}`)
  mergeCounts(tree.droppedHtml, normalized.dropped)

  const children: ImportNode[] = []
  for (const child of [...plan.children].sort((a, b) => a.order - b.order)) children.push(await build(child))

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
