// PowerPoint export: the pages as a Flat ODP (`document.fodp`), which the convert
// service turns into pptx (spec 2026-10-16-office-export §3 PowerPoint).

import { markdownProcessor, matchAlertBlockquote, parseImageAltSize } from '@f451/markdown'
import { withoutLeadHeading } from '../../export/bookstack/html.js'
import { rasterizeSvg } from '../../export/bookstack/raster.js'
import { exportLinks, isDiagram, mediaName, pageMedia, type ExportContext, type ExportLinks } from './links.js'
import type { ExportPageSource } from './load.js'
import { base64, escapeXml, odfPreservedText, tag } from './xml.js'

// Local, minimal mdast node type (as in packages/markdown/src/parse.ts).
interface MNode {
  type: string
  value?: string
  url?: string
  alt?: string | null
  depth?: number
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
  label?: string | null
  identifier?: string
  data?: { alias?: string }
  children?: MNode[]
}

// --- geometry (cm), 16:9 ---

const SLIDE_W = 28
const SLIDE_H = 15.75
const MARGIN_X = 1.5
const CONTENT_W = SLIDE_W - 2 * MARGIN_X
const TITLE_Y = 0.6
const TITLE_H = 2.2
const CONTENT_TOP = 3.2
const CONTENT_BOTTOM = 15
const LINE_CM = 0.8
const CHARS_PER_LINE = 70
const CODE_LINE_CM = 0.5
const TABLE_ROW_CM = 0.9
const BLOCK_GAP = 0.3
const MIN_IMAGE_H = 3
const PX_CM = 2.54 / 96
const FALLBACK_PX = { width: 800, height: 600 }
/** A slide with more estimated lines than this is reported as overfull. */
export const OVERFULL_LINES = 12

const ALERT_LABEL: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

const SPEAKER_NOTES = 'Speaker notes'

type Block =
  | { kind: 'text'; items: Array<{ xml: string; lines: number }> }
  | { kind: 'code'; lines: string[] }
  | { kind: 'image'; bytes: Uint8Array; widthPx: number; heightPx: number; alt: string }
  | { kind: 'table'; rows: string[][] }

interface Slide {
  name: string
  title: string
  /** `title`: title or section slide (title only, centred). */
  layout: 'title' | 'content'
  blocks: Block[]
  notes: string[]
}

const cm = (n: number): string => `${Math.round(n * 1000) / 1000}cm`

function parse(markdown: string): MNode {
  return markdownProcessor.runSync(markdownProcessor.parse(markdown)) as unknown as MNode
}

function plain(nodes: MNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'wikiLink') return n.data?.alias ?? n.value ?? ''
      if (n.type === 'image') return n.alt ?? ''
      if (n.type === 'break') return ' '
      if (n.type === 'footnoteReference') return `[${n.label ?? n.identifier ?? ''}]`
      if (n.type === 'html') return (n.value ?? '').replace(/<[^>]*>/g, '')
      if (typeof n.value === 'string') return n.value
      return plain(n.children)
    })
    .join('')
}

function estimateLines(text: string, perLine = CHARS_PER_LINE): number {
  return Math.max(1, Math.ceil(text.trim().length / Math.max(perLine, 20)))
}

function isBlank(n: MNode): boolean {
  return n.type === 'text' && !(n.value ?? '').trim()
}

// --- image sizes ---

function u16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!
}
function u16le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8)
}
function u24le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!)
}
function ascii(b: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...b.subarray(i, i + n))
}

const SVG_UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }

function svgLength(v: string | undefined): number | null {
  const m = v ? /^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/.exec(v) : null
  if (!m) return null
  const n = Number(m[1]) * SVG_UNIT_PX[m[2] ?? '']!
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Pixel size of a PNG, GIF, JPEG, WebP or SVG from its header; null if unknown. */
export function pixelSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { width: u32be(b, 16), height: u32be(b, 20) }
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') return { width: u16le(b, 6), height: u16le(b, 8) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker >= 0xd0 && marker <= 0xd9) {
        i += 2
        continue
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { width: u16be(b, i + 7), height: u16be(b, i + 5) }
      i += 2 + u16be(b, i + 2)
    }
    return null
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    if (chunk === 'VP8L') {
      const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!]
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
    }
    if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
    return null
  }
  const head = new TextDecoder().decode(b.subarray(0, 65536))
  const svg = /<svg\b[^>]*>/i.exec(head)?.[0]
  if (svg) {
    const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(svg)?.[1]
    const width = svgLength(attr('width'))
    const height = svgLength(attr('height'))
    if (width && height) return { width, height }
    const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
    if (box && box.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! }
  }
  return null
}

// --- slides from Markdown ---

class Deck {
  readonly slides: Slide[] = []

  constructor(
    private readonly links: ExportLinks,
    private readonly ctx: ExportContext,
  ) {}

  addPage(page: ExportPageSource): void {
    const anchor = this.links.anchors.get(page.id)!
    // Start page → title slide; subpage → section slide. Both carry the page anchor.
    this.slides.push({ name: anchor, title: page.title, layout: 'title', blocks: [], notes: [] })
    let n = 0
    const next = (title: string): Slide => ({ name: `${anchor}-${++n}`, title, layout: 'content', blocks: [], notes: [] })
    const pageScope = new PageScope(page, anchor, this.links, this.ctx)
    let slide = next(page.title)
    const flush = () => {
      if (slide.blocks.length > 0 || slide.notes.length > 0) this.slides.push(slide)
    }
    const root = parse(withoutLeadHeading(page.markdown))
    for (const node of root.children ?? []) {
      if (node.type === 'heading' && (node.depth ?? 1) <= 2) {
        flush()
        slide = next(plain(node.children).trim() || page.title)
        continue
      }
      pageScope.block(node, slide)
    }
    flush()
  }
}

class PageScope {
  constructor(
    private readonly page: ExportPageSource,
    private readonly anchor: string,
    private readonly links: ExportLinks,
    private readonly ctx: ExportContext,
  ) {}

  private pushText(slide: Slide, xml: string, lines: number): void {
    const last = slide.blocks[slide.blocks.length - 1]
    if (last?.kind === 'text') last.items.push({ xml, lines })
    else slide.blocks.push({ kind: 'text', items: [{ xml, lines }] })
  }

  private paragraph(inlineXml: string, style = 'P-body'): string {
    return tag('text:p', { 'text:style-name': style }, inlineXml)
  }

  private href(url: string): string | null {
    if (url.includes('://') || url.startsWith('mailto:')) return url
    if (url.startsWith('#')) return `#${this.anchor}`
    const name = mediaName(url)
    if (name !== null) return this.links.mediaUrl(this.page.id, name)
    return this.links.pageHref(url, false)
  }

  inline(nodes: MNode[] | undefined): string {
    let out = ''
    for (const n of nodes ?? []) {
      switch (n.type) {
        case 'text':
          out += escapeXml((n.value ?? '').replace(/\s*\n\s*/g, ' '))
          break
        case 'emphasis':
          out += tag('text:span', { 'text:style-name': 'T-i' }, this.inline(n.children))
          break
        case 'strong':
          out += tag('text:span', { 'text:style-name': 'T-b' }, this.inline(n.children))
          break
        case 'delete':
          out += tag('text:span', { 'text:style-name': 'T-s' }, this.inline(n.children))
          break
        case 'inlineCode':
          out += tag('text:span', { 'text:style-name': 'T-code' }, escapeXml(n.value ?? ''))
          break
        case 'break':
          out += '<text:line-break/>'
          break
        case 'link': {
          const href = this.href(n.url ?? '')
          const inner = this.inline(n.children)
          out += href ? tag('text:a', { 'xlink:type': 'simple', 'xlink:href': href }, inner) : inner
          break
        }
        case 'wikiLink': {
          const text = escapeXml(n.data?.alias ?? n.value ?? '')
          const href = this.links.pageHref(n.value ?? '', false)
          out += href ? tag('text:a', { 'xlink:type': 'simple', 'xlink:href': href }, text) : text
          break
        }
        case 'footnoteReference':
          out += tag('text:span', { 'text:style-name': 'T-sup' }, escapeXml(n.label ?? n.identifier ?? ''))
          break
        case 'image':
          out += escapeXml(parseImageAltSize(n.alt)?.alt ?? n.alt ?? '')
          break
        case 'html':
          out += escapeXml((n.value ?? '').replace(/<[^>]*>/g, ''))
          break
        default:
          if (typeof n.value === 'string') out += escapeXml(n.value)
          else out += this.inline(n.children)
      }
    }
    return out
  }

  /** `paragraph` with its images taken out as image blocks. */
  private paragraphBlock(node: MNode, slide: Slide): void {
    const images: MNode[] = []
    const rest: MNode[] = []
    for (const c of node.children ?? []) {
      if (c.type === 'image') images.push(c)
      else if (c.type === 'link' && (c.children ?? []).length > 0 && (c.children ?? []).every((x) => x.type === 'image' || isBlank(x))) {
        images.push(...(c.children ?? []).filter((x) => x.type === 'image'))
      } else rest.push(c)
    }
    if (rest.some((c) => !isBlank(c))) {
      this.pushText(slide, this.paragraph(this.inline(rest)), estimateLines(plain(rest)))
    }
    for (const img of images) this.image(img, slide)
  }

  private image(node: MNode, slide: Slide): void {
    const size = parseImageAltSize(node.alt)
    const alt = size?.alt ?? node.alt ?? ''
    const url = node.url ?? ''
    const name = mediaName(url)
    let bytes = name !== null ? pageMedia(this.page, name) : undefined
    if (!bytes || name === null) {
      // Missing or remote image: its alt text (remote: as a link).
      const text = escapeXml(alt || url)
      if (/^https?:\/\//i.test(url)) {
        this.pushText(slide, this.paragraph(tag('text:a', { 'xlink:type': 'simple', 'xlink:href': url }, text)), 1)
      } else if (alt) this.pushText(slide, this.paragraph(text), 1)
      return
    }
    if (this.ctx.rasterDiagrams && isDiagram(name)) bytes = rasterizeSvg(bytes)
    const natural = pixelSize(bytes) ?? FALLBACK_PX
    let widthPx = natural.width
    let heightPx = natural.height
    if (size) {
      widthPx = size.width
      heightPx = size.height ?? (natural.width > 0 ? (size.width * natural.height) / natural.width : size.width)
    }
    slide.blocks.push({ kind: 'image', bytes, widthPx, heightPx, alt })
  }

  /** A list as `text:list`; `lines` for the overfull estimate. */
  private list(node: MNode, level: number): { xml: string; lines: number } {
    let lines = 0
    const items: string[] = []
    const perLine = CHARS_PER_LINE - level * 4
    let first = true
    for (const item of node.children ?? []) {
      const parts: string[] = []
      const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : ''
      let prefixed = false
      for (const c of item.children ?? []) {
        if (c.type === 'list') {
          const nested = this.list(c, level + 1)
          parts.push(nested.xml)
          lines += nested.lines
          continue
        }
        const xml = c.type === 'paragraph' ? this.inline(c.children) : escapeXml(plain([c]))
        const text = c.type === 'paragraph' ? plain(c.children) : plain([c])
        parts.push(this.paragraph((prefixed ? '' : escapeXml(check)) + xml))
        prefixed = true
        lines += estimateLines(text, perLine)
      }
      if (parts.length === 0) parts.push(this.paragraph(escapeXml(check)))
      const start = first && node.ordered && node.start !== null && node.start !== undefined && node.start !== 1 ? node.start : undefined
      items.push(tag('text:list-item', { 'text:start-value': start }, parts))
      first = false
    }
    return { xml: tag('text:list', { 'text:style-name': node.ordered ? 'L-num' : 'L-bullet' }, items), lines }
  }

  /** The body of a `> [!NOTE]` whose first paragraph is `**Speaker notes**`, or null. */
  private speakerNotes(node: MNode): readonly MNode[] | null {
    const m = matchAlertBlockquote(node)
    if (!m || m.alertType !== 'note') return null
    const first = m.bodyChildren[0]
    if (!first || first.type !== 'paragraph') return null
    const kids = (first.children ?? []).filter((c) => !isBlank(c))
    if (kids.length !== 1 || kids[0]!.type !== 'strong' || plain(kids[0]!.children).trim() !== SPEAKER_NOTES) return null
    return m.bodyChildren.slice(1)
  }

  private notesParagraphs(nodes: readonly MNode[]): string[] {
    const out: string[] = []
    for (const n of nodes) {
      if (n.type === 'paragraph') out.push(this.paragraph(this.inline(n.children), 'P-notes'))
      else if (n.type === 'list') out.push(this.list(n, 0).xml)
      else if (n.type === 'code') for (const l of (n.value ?? '').split('\n')) out.push(this.paragraph(odfPreservedText(l), 'P-notes'))
      else if (n.children) out.push(...this.notesParagraphs(n.children))
      else if (n.value?.trim()) out.push(this.paragraph(escapeXml(n.value), 'P-notes'))
    }
    return out
  }

  block(node: MNode, slide: Slide): void {
    switch (node.type) {
      case 'paragraph':
        this.paragraphBlock(node, slide)
        return
      case 'heading': {
        const text = this.inline(node.children)
        this.pushText(slide, this.paragraph(tag('text:span', { 'text:style-name': 'T-b' }, text)), estimateLines(plain(node.children)))
        return
      }
      case 'list': {
        const l = this.list(node, 0)
        this.pushText(slide, l.xml, l.lines)
        return
      }
      case 'code':
        slide.blocks.push({ kind: 'code', lines: (node.value ?? '').split('\n') })
        return
      case 'table':
        slide.blocks.push({
          kind: 'table',
          rows: (node.children ?? []).map((row) => (row.children ?? []).map((cell) => this.inline(cell.children))),
        })
        return
      case 'blockquote': {
        const notes = this.speakerNotes(node)
        if (notes) {
          slide.notes.push(...this.notesParagraphs(notes))
          return
        }
        const alert = matchAlertBlockquote(node)
        if (alert) {
          const label = ALERT_LABEL[alert.alertType] ?? alert.alertType
          this.pushText(slide, this.paragraph(tag('text:span', { 'text:style-name': 'T-b' }, escapeXml(label))), 1)
          for (const c of alert.bodyChildren) this.block(c, slide)
          return
        }
        for (const c of node.children ?? []) this.block(c, slide)
        return
      }
      case 'footnoteDefinition': {
        const label = escapeXml(`[${node.label ?? node.identifier ?? ''}] `)
        const text = (node.children ?? []).map((c) => (c.type === 'paragraph' ? this.inline(c.children) : escapeXml(plain([c])))).join(' ')
        this.pushText(slide, this.paragraph(label + text), estimateLines(plain(node.children)))
        return
      }
      case 'html': {
        const text = (node.value ?? '').replace(/<[^>]*>/g, '').trim()
        if (text) this.pushText(slide, this.paragraph(escapeXml(text)), estimateLines(text))
        return
      }
      case 'yaml':
      case 'definition':
      case 'thematicBreak':
        return
      default: {
        const text = plain([node]).trim()
        if (text) this.pushText(slide, this.paragraph(escapeXml(text)), estimateLines(text))
      }
    }
  }
}

// --- slides → XML ---

function frame(style: string, x: number, y: number, w: number, h: number, content: string): string {
  return tag(
    'draw:frame',
    { 'draw:style-name': style, 'draw:layer': 'layout', 'svg:width': cm(w), 'svg:height': cm(h), 'svg:x': cm(x), 'svg:y': cm(y) },
    content,
  )
}

function titleFrame(title: string, centred: boolean): string {
  const y = centred ? (SLIDE_H - 3) / 2 : TITLE_Y
  const h = centred ? 3 : TITLE_H
  return tag(
    'draw:frame',
    {
      'presentation:style-name': 'Default-title',
      'draw:layer': 'layout',
      'svg:width': cm(CONTENT_W),
      'svg:height': cm(h),
      'svg:x': cm(MARGIN_X),
      'svg:y': cm(y),
      'presentation:class': 'title',
      'presentation:user-transformed': 'true',
    },
    tag('draw:text-box', {}, tag('text:p', {}, escapeXml(title))),
  )
}

/** Lines that count towards the overfull limit. */
function slideLines(slide: Slide): number {
  let lines = 0
  for (const b of slide.blocks) {
    if (b.kind === 'text') lines += b.items.reduce((s, i) => s + i.lines, 0)
    else if (b.kind === 'code') lines += b.lines.length
    else if (b.kind === 'table') lines += b.rows.length
  }
  return lines
}

class SlideXml {
  /** Column width (cm, rounded) → automatic style name. */
  readonly columnStyles = new Map<string, string>()

  slide(s: Slide): string {
    const parts = [titleFrame(s.title, s.layout === 'title')]
    let y = CONTENT_TOP
    for (const b of s.blocks) {
      const placed = this.block(b, y)
      parts.push(placed.xml)
      y += placed.height + BLOCK_GAP
    }
    if (s.notes.length > 0) {
      parts.push(
        tag(
          'presentation:notes',
          { 'draw:style-name': 'dp1' },
          tag(
            'draw:frame',
            {
              'presentation:style-name': 'Default-notes',
              'draw:layer': 'layout',
              'svg:width': '17cm',
              'svg:height': '12cm',
              'svg:x': '2cm',
              'svg:y': '14cm',
              'presentation:class': 'notes',
              'presentation:user-transformed': 'true',
            },
            tag('draw:text-box', {}, s.notes),
          ),
        ),
      )
    }
    return tag('draw:page', { 'draw:name': s.name, 'draw:style-name': 'dp1', 'draw:master-page-name': 'Default' }, parts)
  }

  private block(b: Block, y: number): { xml: string; height: number } {
    switch (b.kind) {
      case 'text': {
        const lines = b.items.reduce((s, i) => s + i.lines, 0)
        const height = lines * LINE_CM + 0.3
        return { xml: frame('gr-text', MARGIN_X, y, CONTENT_W, height, tag('draw:text-box', {}, b.items.map((i) => i.xml))), height }
      }
      case 'code': {
        const height = b.lines.length * CODE_LINE_CM + 0.5
        const paras = b.lines.map((l) => tag('text:p', { 'text:style-name': 'P-code' }, odfPreservedText(l)))
        return { xml: frame('gr-code', MARGIN_X, y, CONTENT_W, height, tag('draw:text-box', {}, paras)), height }
      }
      case 'image': {
        const maxH = Math.max(CONTENT_BOTTOM - y, MIN_IMAGE_H)
        const w = b.widthPx * PX_CM
        const h = b.heightPx * PX_CM
        const scale = Math.min(1, CONTENT_W / w, maxH / h)
        const width = w * scale
        const height = h * scale
        const content =
          tag('draw:image', {}, tag('office:binary-data', {}, base64(b.bytes))) +
          (b.alt ? tag('svg:title', {}, escapeXml(b.alt)) : '')
        return { xml: frame('gr-image', MARGIN_X + (CONTENT_W - width) / 2, y, width, height, content), height }
      }
      case 'table': {
        const cols = Math.max(1, ...b.rows.map((r) => r.length))
        const colStyle = this.columnStyle(CONTENT_W / cols)
        const rows = b.rows.map((row, ri) => {
          const cells: string[] = []
          for (let c = 0; c < cols; c++) {
            const inner = row[c] ?? ''
            const xml = ri === 0 && inner ? tag('text:span', { 'text:style-name': 'T-b' }, inner) : inner
            cells.push(tag('table:table-cell', { 'table:style-name': 'ce1' }, tag('text:p', { 'text:style-name': 'P-cell' }, xml)))
          }
          return tag('table:table-row', {}, cells)
        })
        const columns = Array.from({ length: cols }, () => tag('table:table-column', { 'table:style-name': colStyle }))
        const height = b.rows.length * TABLE_ROW_CM
        const table = tag('table:table', { 'table:use-first-row-styles': 'true' }, [...columns, ...rows])
        return { xml: frame('gr-table', MARGIN_X, y, CONTENT_W, height, table), height }
      }
    }
  }

  private columnStyle(widthCm: number): string {
    const key = cm(widthCm)
    let name = this.columnStyles.get(key)
    if (!name) {
      name = `co${this.columnStyles.size + 1}`
      this.columnStyles.set(key, name)
    }
    return name
  }
}

// --- document template ---

const NS = {
  'xmlns:office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  'xmlns:style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  'xmlns:text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  'xmlns:table': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  'xmlns:draw': 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  'xmlns:fo': 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  'xmlns:xlink': 'http://www.w3.org/1999/xlink',
  'xmlns:svg': 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  'xmlns:presentation': 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
}

/** Bullet or number list style with nine levels, indented 0.8 cm per level. */
function listStyle(name: string, numbered: boolean): string {
  const levels: string[] = []
  const bullets = ['•', '–', '◦']
  for (let level = 1; level <= 9; level++) {
    const props = tag('style:list-level-properties', {
      'text:space-before': cm((level - 1) * 0.8),
      'text:min-label-width': cm(0.7),
    })
    levels.push(
      numbered
        ? tag('text:list-level-style-number', { 'text:level': level, 'style:num-format': '1', 'style:num-suffix': '.' }, props)
        : tag('text:list-level-style-bullet', { 'text:level': level, 'text:bullet-char': bullets[(level - 1) % 3] }, props),
    )
  }
  return tag('text:list-style', { 'style:name': name }, levels)
}

function style(name: string, family: string, children: string, attrs: Record<string, string> = {}): string {
  return tag('style:style', { 'style:name': name, 'style:family': family, ...attrs }, children)
}

const text = (props: Record<string, string>) => tag('style:text-properties', props)
const graphic = (props: Record<string, string>, children = '') => tag('style:graphic-properties', props, children)

const FONT_FACES = tag('office:font-face-decls', {}, [
  tag('style:font-face', { 'style:name': 'Liberation Sans', 'svg:font-family': "'Liberation Sans'", 'style:font-family-generic': 'swiss' }),
  tag('style:font-face', {
    'style:name': 'Liberation Mono',
    'svg:font-family': "'Liberation Mono'",
    'style:font-family-generic': 'modern',
    'style:font-pitch': 'fixed',
  }),
])

const COMMON_STYLES = tag('office:styles', {}, [
  tag('style:default-style', { 'style:family': 'graphic' }, text({ 'style:font-name': 'Liberation Sans', 'fo:font-size': '18pt' })),
  style(
    'Default-title',
    'presentation',
    graphic({ 'draw:stroke': 'none', 'draw:fill': 'none', 'draw:textarea-vertical-align': 'middle' }) +
      text({ 'style:font-name': 'Liberation Sans', 'fo:font-size': '32pt', 'fo:font-weight': 'bold' }),
  ),
  // Outline levels of the master's body placeholder: bullets per level.
  style(
    'Default-outline1',
    'presentation',
    graphic({ 'draw:stroke': 'none', 'draw:fill': 'none' }, listStyle('Default-outline-list', false)) +
      text({ 'fo:font-size': '18pt' }),
  ),
  ...Array.from({ length: 8 }, (_, i) =>
    style(`Default-outline${i + 2}`, 'presentation', '', { 'style:parent-style-name': `Default-outline${i + 1}` }),
  ),
  style('Default-notes', 'presentation', text({ 'fo:font-size': '12pt' })),
  listStyle('L-bullet', false),
  listStyle('L-num', true),
])

function automaticStyles(columnStyles: Map<string, string>): string {
  return tag('office:automatic-styles', {}, [
    tag(
      'style:page-layout',
      { 'style:name': 'PM1' },
      tag('style:page-layout-properties', {
        'fo:margin-top': '0cm',
        'fo:margin-bottom': '0cm',
        'fo:margin-left': '0cm',
        'fo:margin-right': '0cm',
        'fo:page-width': cm(SLIDE_W),
        'fo:page-height': cm(SLIDE_H),
        'style:print-orientation': 'landscape',
      }),
    ),
    style('dp1', 'drawing-page', tag('style:drawing-page-properties', { 'presentation:background-visible': 'true', 'presentation:background-objects-visible': 'true' })),
    style('gr-text', 'graphic', graphic({ 'draw:stroke': 'none', 'draw:fill': 'none', 'draw:auto-grow-height': 'false', 'draw:textarea-vertical-align': 'top', 'fo:padding': '0.1cm' })),
    style(
      'gr-code',
      'graphic',
      graphic({
        'draw:stroke': 'solid',
        'svg:stroke-color': '#c0c0c0',
        'draw:fill': 'solid',
        'draw:fill-color': '#f4f4f4',
        'draw:auto-grow-height': 'false',
        'draw:textarea-vertical-align': 'top',
        'fo:padding': '0.2cm',
      }),
    ),
    style('gr-image', 'graphic', graphic({ 'draw:stroke': 'none', 'draw:fill': 'none' })),
    style('gr-table', 'graphic', graphic({ 'draw:stroke': 'none', 'draw:fill': 'none' })),
    style('P-body', 'paragraph', tag('style:paragraph-properties', { 'fo:margin-bottom': '0.15cm' }) + text({ 'fo:font-size': '18pt' })),
    style('P-code', 'paragraph', text({ 'style:font-name': 'Liberation Mono', 'fo:font-size': '12pt' })),
    style('P-cell', 'paragraph', text({ 'fo:font-size': '14pt' })),
    style('P-notes', 'paragraph', text({ 'fo:font-size': '12pt' })),
    style('T-b', 'text', text({ 'fo:font-weight': 'bold' })),
    style('T-i', 'text', text({ 'fo:font-style': 'italic' })),
    style('T-s', 'text', text({ 'style:text-line-through-style': 'solid' })),
    style('T-code', 'text', text({ 'style:font-name': 'Liberation Mono' })),
    style('T-sup', 'text', text({ 'style:text-position': 'super 58%' })),
    style('ce1', 'table-cell', graphic({ 'draw:fill': 'none' }) + tag('style:paragraph-properties', { 'fo:border': '0.03cm solid #808080' })),
    ...[...columnStyles].map(([width, name]) => style(name, 'table-column', tag('style:table-column-properties', { 'style:column-width': width }))),
  ])
}

const MASTER_STYLES = tag('office:master-styles', {}, [
  tag(
    'draw:layer-set',
    {},
    ['layout', 'background', 'backgroundobjects', 'controls', 'measurelines'].map((n) => tag('draw:layer', { 'draw:name': n })),
  ),
  tag('style:master-page', { 'style:name': 'Default', 'style:page-layout-name': 'PM1', 'draw:style-name': 'dp1' }, [
    tag(
      'draw:frame',
      {
        'presentation:style-name': 'Default-title',
        'draw:layer': 'backgroundobjects',
        'svg:width': cm(CONTENT_W),
        'svg:height': cm(TITLE_H),
        'svg:x': cm(MARGIN_X),
        'svg:y': cm(TITLE_Y),
        'presentation:class': 'title',
        'presentation:placeholder': 'true',
      },
      tag('draw:text-box'),
    ),
    tag(
      'draw:frame',
      {
        'presentation:style-name': 'Default-outline1',
        'draw:layer': 'backgroundobjects',
        'svg:width': cm(CONTENT_W),
        'svg:height': cm(CONTENT_BOTTOM - CONTENT_TOP),
        'svg:x': cm(MARGIN_X),
        'svg:y': cm(CONTENT_TOP),
        'presentation:class': 'outline',
        'presentation:placeholder': 'true',
      },
      tag('draw:text-box'),
    ),
  ]),
])

/** The Flat ODP and the titles of slides with more than `OVERFULL_LINES` lines. */
export function renderFodp(pages: ExportPageSource[], ctx: ExportContext): { xml: string; overfullSlides: string[] } {
  const deck = new Deck(exportLinks(pages, ctx), ctx)
  for (const p of pages) deck.addPage(p)
  const writer = new SlideXml()
  const slides = deck.slides.map((s) => writer.slide(s))
  const overfullSlides = deck.slides.filter((s) => slideLines(s) > OVERFULL_LINES).map((s) => s.title)
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    tag(
      'office:document',
      { ...NS, 'office:version': '1.3', 'office:mimetype': 'application/vnd.oasis.opendocument.presentation' },
      [
        FONT_FACES,
        COMMON_STYLES,
        automaticStyles(writer.columnStyles),
        MASTER_STYLES,
        tag('office:body', {}, tag('office:presentation', {}, slides)),
      ],
    )
  return { xml, overfullSlides }
}

export function buildFodp(pages: ExportPageSource[], ctx: ExportContext): string {
  return renderFodp(pages, ctx).xml
}
