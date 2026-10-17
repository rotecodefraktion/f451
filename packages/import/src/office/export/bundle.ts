// Word/PDF export: the pages as one `document.html` plus `media/*`, zipped for the
// convert service (spec 2026-10-16-office-export §2). Pure, given the page sources.

import { renderHtml } from '@f451/markdown'
import { strToU8, zipSync } from 'fflate'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { withoutLeadHeading } from '../../export/bookstack/html.js'
import { rasterizeSvg } from '../../export/bookstack/raster.js'
import { exportLinks, isDiagram, mediaName, pageMedia, type ExportContext, type ExportLinks } from './links.js'
import { pixelSize } from './fodp.js'
import type { ExportPageSource } from './load.js'

export type { ExportContext } from './links.js'

// Local, minimal hast node types instead of an @types/hast dependency (as in
// export/bookstack/html.ts).
interface HNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
  value?: string
}

interface HElement extends HNode {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HNode[]
}

const ALERT_LABEL: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

const HEADING = /^h([1-6])$/

function el(tagName: string, properties: Record<string, unknown>, children: HNode[] = []): HElement {
  return { type: 'element', tagName, properties, children }
}

function txt(value: string): HNode {
  return { type: 'text', value }
}

function isElement(node: HNode | undefined, tagName?: string): node is HElement {
  return node?.type === 'element' && (tagName === undefined || node.tagName === tagName)
}

function classes(e: HElement): string[] {
  const value = e.properties.className
  return Array.isArray(value) ? value.map(String) : []
}

function hasProp(e: HElement, name: string): boolean {
  const v = e.properties[name]
  return v !== undefined && v !== null && v !== false
}

function isBlankText(node: HNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim()
}

/** Media files of the bundle: one name per (page, file), unique across pages. */
class BundleMedia {
  readonly files = new Map<string, Uint8Array>()
  private readonly byRef = new Map<string, string>()

  constructor(private readonly rasterDiagrams: boolean) {}

  /** The bundle path (`media/…`) of a page image, or null if the page has no such file. */
  add(page: ExportPageSource, anchor: string, name: string): string | null {
    const key = `${page.id}\0${name}`
    const known = this.byRef.get(key)
    if (known) return known
    let bytes = pageMedia(page, name)
    if (!bytes) return null
    let fileName = name.split('/').pop()!.replace(/[^A-Za-z0-9._-]/g, '_')
    if (this.rasterDiagrams && isDiagram(name)) {
      bytes = rasterizeSvg(bytes)
      fileName = fileName.replace(/\.svg$/i, '.png')
    }
    const dot = fileName.lastIndexOf('.')
    const stem = `${anchor}-${dot > 0 ? fileName.slice(0, dot) : fileName}`
    const ext = dot > 0 ? fileName.slice(dot) : ''
    let path = `media/${stem}${ext}`
    for (let n = 2; this.files.has(path); n++) path = `media/${stem}-${n}${ext}`
    this.files.set(path, bytes)
    this.byRef.set(key, path)
    return path
  }
}

/** Footnote numbering and the LibreOffice footnote bodies, across the whole document. */
class Footnotes {
  readonly bodies: HElement[] = []
  private count = 0

  /** Replaces a GFM footnote reference by LibreOffice's anchor markup. A note
   *  referenced again only repeats its number. */
  reference(noteId: string, notes: Map<string, { li: HElement; number?: number }>): HNode {
    const note = notes.get(noteId)
    if (!note) return el('sup', {}, [txt('?')])
    if (note.number !== undefined) return el('sup', {}, [txt(String(note.number))])
    const n = ++this.count
    note.number = n
    this.bodies.push(this.body(n, note.li))
    return el('a', { className: ['sdfootnoteanc'], name: `sdfootnote${n}anc`, href: `#sdfootnote${n}sym` }, [
      el('sup', {}, [txt(String(n))]),
    ])
  }

  private body(n: number, li: HElement): HElement {
    const sym = el('a', { className: ['sdfootnotesym'], name: `sdfootnote${n}sym`, href: `#sdfootnote${n}anc` }, [
      txt(String(n)),
    ])
    const blocks = li.children.filter((c) => !isBlankText(c))
    const first = blocks[0]
    const head = isElement(first, 'p')
      ? el('p', { className: ['sdfootnote'] }, [sym, txt('\u00a0'), ...first.children])
      : el('p', { className: ['sdfootnote'] }, [sym, txt('\u00a0')])
    const rest = isElement(first, 'p') ? blocks.slice(1) : blocks
    return el('div', { id: `sdfootnote${n}` }, [head, ...rest])
  }
}

function isBackref(node: HNode): boolean {
  return isElement(node, 'a') && hasProp(node, 'dataFootnoteBackref')
}

/** Removes backref anchors (recursively) and the white space left before them. */
function stripBackrefs(node: HNode): void {
  if (!node.children) return
  const before = node.children.length
  node.children = node.children.filter((c) => !isBackref(c))
  for (const c of node.children) stripBackrefs(c)
  if (node.children.length === before) return
  while (node.children.length > 0) {
    const last = node.children[node.children.length - 1]!
    if (last.type !== 'text') break
    last.value = (last.value ?? '').trimEnd()
    if (last.value !== '') break
    node.children.pop()
  }
}

/** Takes the GFM footnote section out of the page; returns its notes by li id. */
function takeFootnotes(root: HNode): Map<string, { li: HElement; number?: number }> {
  const notes = new Map<string, { li: HElement; number?: number }>()
  const visit = (node: HNode): void => {
    if (!node.children) return
    node.children = node.children.filter((c) => {
      if (isElement(c, 'section') && hasProp(c, 'dataFootnotes')) {
        const collect = (n: HNode) => {
          for (const child of n.children ?? []) {
            if (isElement(child, 'li') && typeof child.properties.id === 'string') {
              stripBackrefs(child)
              notes.set(child.properties.id, { li: child })
            } else collect(child)
          }
        }
        collect(c)
        return false
      }
      return true
    })
    for (const c of node.children) visit(c)
  }
  visit(root)
  return notes
}

/** The GFM footnote reference inside `<sup>`, if that is all the sup holds. */
function footnoteRef(node: HNode): HElement | null {
  if (!isElement(node, 'sup')) return null
  const content = node.children.filter((c) => !isBlankText(c))
  const only = content.length === 1 ? content[0] : undefined
  return isElement(only, 'a') && hasProp(only, 'dataFootnoteRef') ? only : null
}

/** A GFM alert as a bordered one-cell table, the label in bold. */
function alertTable(alert: HElement, kind: string): HElement {
  const body = alert.children.filter((c) => !(isElement(c, 'p') && classes(c).includes('alert-title')))
  const label = el('p', {}, [el('strong', {}, [txt(ALERT_LABEL[kind] ?? kind)])])
  const cell = el('td', {}, [label, ...body])
  return el('table', { border: '1', cellPadding: '6', cellSpacing: '0', width: '100%' }, [
    el('tbody', {}, [el('tr', {}, [cell])]),
  ])
}

function alertKind(e: HElement): string | null {
  if (e.tagName !== 'div') return null
  const cls = classes(e)
  if (!cls.includes('alert')) return null
  const kind = cls.find((c) => c.startsWith('alert-') && c.slice('alert-'.length) in ALERT_LABEL)
  return kind ? kind.slice('alert-'.length) : null
}

interface PageScope {
  anchor: string
  depth: number
  /** Placeholder href → real in-document href (see `renderPage`). */
  tokens: Map<string, string>
  notes: Map<string, { li: HElement; number?: number }>
  footnotes: Footnotes
}

/** Rewrites the children of `node` in place for the export. */
function transform(node: HNode, scope: PageScope): void {
  if (!node.children) return
  const out: HNode[] = []
  for (const child of node.children) {
    if (!isElement(child)) {
      out.push(child)
      continue
    }
    const ref = footnoteRef(child)
    if (ref) {
      const href = typeof ref.properties.href === 'string' ? ref.properties.href : ''
      out.push(scope.footnotes.reference(href.replace(/^#/, ''), scope.notes))
      continue
    }
    // Unresolved links: plain text (as in the BookStack export).
    if (child.tagName === 'span' && classes(child).includes('broken-link')) {
      transform(child, scope)
      out.push(...child.children)
      continue
    }
    // YouTube embed: a plain link (no remote thumbnail in the file).
    if (child.tagName === 'div' && classes(child).includes('yt-embed')) {
      const link = child.children.find((c): c is HElement => isElement(c, 'a'))
      const href = link && typeof link.properties.href === 'string' ? link.properties.href : ''
      if (href) out.push(el('p', {}, [el('a', { href }, [txt(href)])]))
      continue
    }
    if (child.tagName === 'img') {
      out.push(...image(child))
      continue
    }
    transform(child, scope)
    const kind = alertKind(child)
    if (kind) {
      out.push(alertTable(child, kind))
      continue
    }
    const h = HEADING.exec(child.tagName)
    if (h) {
      child.tagName = `h${Math.min(Number(h[1]) + scope.depth, 6)}`
      if (typeof child.properties.id === 'string') child.properties.id = `${scope.anchor}-${child.properties.id}`
    }
    if (child.tagName === 'a' && typeof child.properties.href === 'string') {
      const href = child.properties.href
      const real = scope.tokens.get(href)
      if (real !== undefined) child.properties.href = real
      else if (href.startsWith('#') && href.length > 1) child.properties.href = `#${scope.anchor}-${href.slice(1)}`
    }
    out.push(child)
  }
  node.children = out
}

/** A bundled image stays; a missing page image becomes its alt text; a remote
 *  image becomes a link (the convert service fetches nothing). */
function image(img: HElement): HNode[] {
  const src = typeof img.properties.src === 'string' ? img.properties.src : ''
  const alt = typeof img.properties.alt === 'string' ? img.properties.alt : ''
  if (src.startsWith('media/')) return [img]
  if (/^https?:\/\//i.test(src)) return [el('a', { href: src }, [txt(alt || src)])]
  return alt ? [txt(alt)] : []
}

function findAll(node: HNode, pred: (e: HElement) => boolean, out: HElement[] = []): HElement[] {
  for (const c of node.children ?? []) {
    if (isElement(c)) {
      if (pred(c)) out.push(c)
      findAll(c, pred, out)
    }
  }
  return out
}

/** Text width of Writer's default page (A4/Letter, 2 cm margins) in CSS px. */
const MAX_IMAGE_PX = 600

/** Writer sizes an image without `width`/`height` oddly (an SVG chart came out
 *  as a thumbnail), so each bundled image gets its natural size, scaled down to
 *  the text width. A width the Markdown set (`![x|400]`) is kept. */
function sizeImages(root: HNode, media: BundleMedia): void {
  for (const img of findAll(root, (e) => e.tagName === 'img')) {
    const src = typeof img.properties.src === 'string' ? img.properties.src : ''
    const bytes = media.files.get(src)
    const size = bytes ? pixelSize(bytes) : null
    if (!size) continue
    const given = Number(img.properties.width)
    const width = Math.min(given > 0 ? given : size.width, MAX_IMAGE_PX)
    img.properties.width = String(Math.round(width))
    img.properties.height = String(Math.round((width * size.height) / size.width))
  }
}

function renderPage(
  page: ExportPageSource,
  links: ExportLinks,
  media: BundleMedia,
  footnotes: Footnotes,
): HNode[] {
  const anchor = links.anchors.get(page.id)!
  // In-document hrefs start with `#` like same-page links, which the transform
  // prefixes with the page anchor. Placeholders keep the two apart.
  const tokens = new Map<string, string>()
  const html = renderHtml(withoutLeadHeading(page.markdown), {
    resolveLink(raw) {
      const name = mediaName(raw)
      if (name !== null) return { href: links.mediaUrl(page.id, name) }
      const href = links.pageHref(raw, true)
      if (href === null) return null
      if (!href.startsWith('#')) return { href }
      const token = `#f451-export-link-${tokens.size + 1}`
      tokens.set(token, href)
      return { href: token }
    },
    resolveImage(src) {
      const name = mediaName(src)
      if (name === null) return src
      return media.add(page, anchor, name) ?? src
    },
  })
  const root = fromHtml(html, { fragment: true }) as unknown as HNode
  const notes = takeFootnotes(root)
  const scope: PageScope = { anchor, depth: page.depth, tokens, notes, footnotes }
  // Footnote bodies first: they are moved to the end once referenced.
  for (const note of notes.values()) transform(note.li, scope)
  transform(root, scope)
  sizeImages(root, media)
  for (const table of findAll(root, (e) => e.tagName === 'table')) {
    // Writer draws HTML tables without borders unless the attribute is set.
    if (table.properties.border === undefined) Object.assign(table.properties, { border: '1', cellPadding: '4', cellSpacing: '0' })
  }
  const title = el(`h${Math.min(page.depth + 1, 6)}`, { id: anchor }, [txt(page.title)])
  return [title, ...(root.children ?? [])]
}

/** The document as HTML and its media, before zipping (for tests and the bundle). */
export function renderExportHtml(
  pages: ExportPageSource[],
  ctx: ExportContext,
): { html: string; media: Map<string, Uint8Array> } {
  const links = exportLinks(pages, ctx)
  const media = new BundleMedia(ctx.rasterDiagrams)
  const footnotes = new Footnotes()
  const body: HNode[] = []
  for (const page of pages) body.push(...renderPage(page, links, media, footnotes))
  body.push(...footnotes.bodies)
  const doc = {
    type: 'root',
    children: [
      { type: 'doctype' },
      el('html', {}, [
        el('head', {}, [el('meta', { charSet: 'utf-8' }), el('title', {}, [txt(pages[0]?.title ?? '')])]),
        el('body', {}, body),
      ]),
    ],
  }
  return { html: toHtml(doc as never), media: media.files }
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** ZIP with `document.html`, the input of `Converter.fromBundle` for docx/pdf.
 *  Writer only links images given by path (the .docx would point into the
 *  service's work dir), but embeds `data:` URIs — SVG with a PNG fallback — so
 *  every image goes into the HTML inline. */
export function buildHtmlBundle(pages: ExportPageSource[], ctx: ExportContext): Uint8Array {
  const rendered = renderExportHtml(pages, ctx)
  let html = rendered.html
  const media = rendered.media
  for (const [path, bytes] of media) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const uri = `data:${IMAGE_MIME[ext] ?? 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`
    html = html.split(`src="${path}"`).join(`src="${uri}"`)
  }
  return zipSync({ 'document.html': strToU8(html) })
}
