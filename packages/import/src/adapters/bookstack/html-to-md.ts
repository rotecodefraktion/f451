/// <reference path="./gfm.d.ts" />
// Adapted from BookBridge (github.com/rotecodefraktion/bookbridge)

import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'

// In Node, turndown parses HTML with its bundled DOM (domino), so no browser
// environment is needed.

export interface ConversionContext {
  baseUrl: string
  /** Maps a BookStack link (`/books/<b>/page/<p>`, `/link/<id>`, relative or
   *  absolute) to the source page; null if it is not part of the import. */
  resolveInternalLink(href: string): { id: string; url: string } | null
}

export interface DrawingRef {
  id: string
  src: string
  alt: string
}

export interface ConversionResult {
  markdown: string
  drawings: DrawingRef[]
  /** Constructs Markdown cannot express, counted per kind (e.g. `colspan`). */
  dropped: Record<string, number>
}

interface ConversionState {
  drawings: DrawingRef[]
  dropped: Record<string, number>
}

type CalloutType = 'info' | 'success' | 'warning' | 'danger'

const ALERT: Record<CalloutType, string> = {
  info: 'NOTE',
  success: 'TIP',
  warning: 'WARNING',
  danger: 'CAUTION',
}

const INLINE_LABEL: Record<CalloutType, string> = {
  info: 'Note:',
  success: 'Tip:',
  warning: 'Warning:',
  danger: 'Caution:',
}

function createTurndownService(context: ConversionContext, state: ConversionState): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  })

  turndown.use(gfm)

  // Later rules take precedence over earlier ones.
  addYouTubeRule(turndown)
  addCalloutRule(turndown)
  addCodeBlockRule(turndown)
  addDetailsSummaryRule(turndown)
  addLinkedImageRule(turndown)
  addInternalLinkRule(turndown, context)
  addDrawingRule(turndown, state)

  return turndown
}

/** Converts BookStack page HTML to CommonMark + GFM. Throws if turndown fails;
 *  the caller marks the page as failed. */
export function htmlToMarkdown(html: string, context: ConversionContext): ConversionResult {
  const state: ConversionState = { drawings: [], dropped: {} }
  if (!html || !html.trim()) return { markdown: '', ...state }

  const turndown = createTurndownService(context, state)

  try {
    const prepared = prepareTables(html, state.dropped)
    return { markdown: turndown.turndown(prepared), ...state }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`HTML conversion failed: ${message}`, { cause: error })
  }
}

// --- Table pre-processing ----------------------------------------------------
//
// The GFM plugin emits an invalid table for spanning cells (header and
// separator differ in cell count) and keeps tables with block content in a cell
// as raw HTML. Both are fixed on the HTML before turndown sees it: spans are
// expanded into empty cells, block content in cells is flattened to inline.

// Local, minimal hast node types instead of an @types/hast dependency (as in
// packages/markdown).
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

/** Separator between flattened blocks; `'; '` (list items) beats `' '`. */
interface Break {
  type: 'break'
  sep: '; ' | ' '
}

type Piece = HNode | Break

const MAX_COLSPAN = 1000
const MAX_ROWSPAN = 1000

const TABLE_SECTIONS = new Set(['thead', 'tbody', 'tfoot'])
/** Block content that makes the GFM plugin keep a table as HTML. */
const FLATTEN_TRIGGERS = new Set(['ul', 'ol', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote'])
/** Containers that are unwrapped when a cell is flattened. */
const BLOCK_CONTAINERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'])

function isElement(node: HNode | undefined, tagName?: string): node is HElement {
  return node?.type === 'element' && (tagName === undefined || node.tagName === tagName)
}

function isCell(node: HNode): node is HElement {
  return isElement(node, 'td') || isElement(node, 'th')
}

function isBlankText(node: HNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim()
}

function textContent(node: HNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textContent).join('')
}

function classes(el: HElement): string[] {
  const value = el.properties.className
  return Array.isArray(value) ? value.map(String) : []
}

function emptyCell(tagName: string): HElement {
  return { type: 'element', tagName, properties: {}, children: [] }
}

function text(value: string): HNode {
  return { type: 'text', value }
}

/** Expands spans and flattens block content in every table of `html`. Returns
 *  the input unchanged when it contains no table. */
function prepareTables(html: string, dropped: Record<string, number>): string {
  if (!/<table\b/i.test(html)) return html

  const root = fromHtml(html, { fragment: true }) as unknown as HNode
  const tables: HElement[] = []
  const collect = (node: HNode): void => {
    for (const child of node.children ?? []) {
      if (isElement(child, 'table')) tables.push(child)
      collect(child)
    }
  }
  collect(root)

  for (const table of tables) {
    const rows = expandSpans(table, dropped)
    // After expanding: a rowspan inside the thead must still reach its rows.
    demoteExtraHeaderRows(table)
    padRows(rows)
    for (const row of rows) {
      for (const cell of row.children) {
        if (isCell(cell) && needsFlattening(cell)) {
          cell.children = flatten(cell.children)
          bump(dropped, 'tableBlock')
        }
      }
    }
  }

  return toHtml(root as never)
}

/** The table's own rows (not those of nested tables), grouped by row group:
 *  a rowspan never crosses a group boundary. */
function rowGroups(table: HElement): HElement[][] {
  const groups: HElement[][] = []
  let loose: HElement[] | null = null
  for (const child of table.children) {
    if (isElement(child, 'tr')) {
      if (!loose) {
        loose = []
        groups.push(loose)
      }
      loose.push(child)
      continue
    }
    loose = null
    if (isElement(child) && TABLE_SECTIONS.has(child.tagName)) {
      groups.push(child.children.filter((row): row is HElement => isElement(row, 'tr')))
    }
  }
  return groups
}

function spanValue(value: unknown, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 1 ? Math.min(Math.floor(n), max) : 1
}

/** colspan=n → the cell plus n−1 empty cells of the same tag; rowspan=n → an
 *  empty cell at the same column in the next n−1 rows. Each row keeps only its
 *  cells (whitespace between them is dropped). Returns all rows in order. */
function expandSpans(table: HElement, dropped: Record<string, number>): HElement[] {
  const rows: HElement[] = []
  for (const group of rowGroups(table)) {
    const carry = new Map<number, { left: number; tagName: string }>()
    for (const row of group) {
      const out: HNode[] = []
      let col = 0
      const takeCarried = (): boolean => {
        const carried = carry.get(col)
        if (!carried || carried.left <= 0) return false
        out.push(emptyCell(carried.tagName))
        carried.left--
        col++
        return true
      }

      for (const cell of row.children.filter(isCell)) {
        while (takeCarried()) {
          // fill the columns occupied by cells spanning from above
        }
        const colSpan = spanValue(cell.properties.colSpan, MAX_COLSPAN)
        const rowSpan = spanValue(cell.properties.rowSpan, MAX_ROWSPAN)
        if (colSpan > 1) bump(dropped, 'colspan')
        if (rowSpan > 1) bump(dropped, 'rowspan')
        delete cell.properties.colSpan
        delete cell.properties.rowSpan

        out.push(cell)
        for (let i = 1; i < colSpan; i++) out.push(emptyCell(cell.tagName))
        if (rowSpan > 1) {
          for (let i = 0; i < colSpan; i++) carry.set(col + i, { left: rowSpan - 1, tagName: cell.tagName })
        }
        col += colSpan
      }

      // Cells carried into columns after the row's own last cell; gaps before
      // them are filled so the carried cell stays in its column.
      let lastCarried = -1
      for (const [index, carried] of carry) {
        if (carried.left > 0 && index > lastCarried) lastCarried = index
      }
      while (col <= lastCarried) {
        if (!takeCarried()) {
          out.push(emptyCell('td'))
          col++
        }
      }

      row.children = out
      rows.push(row)
    }
  }
  return rows
}

/** GFM has exactly one header row, but the plugin treats every thead row as
 *  one and writes a separator after each. Keeps the first thead row as header
 *  and moves the others, as `td` cells, to the start of the first tbody
 *  (created after the thead if missing). */
function demoteExtraHeaderRows(table: HElement): void {
  const thead = table.children.find((child): child is HElement => isElement(child, 'thead'))
  if (!thead) return
  const extra = thead.children.filter((child): child is HElement => isElement(child, 'tr')).slice(1)
  if (extra.length === 0) return

  thead.children = thead.children.filter((child) => !extra.includes(child as HElement))
  for (const row of extra) {
    for (const cell of row.children) {
      if (isElement(cell, 'th')) cell.tagName = 'td'
    }
  }

  let tbody = table.children.find((child): child is HElement => isElement(child, 'tbody'))
  if (!tbody) {
    tbody = { type: 'element', tagName: 'tbody', properties: {}, children: [] }
    table.children.splice(table.children.indexOf(thead) + 1, 0, tbody)
  }
  tbody.children.unshift(...extra)
}

/** Pads every row to the widest row, so header, separator and body rows have
 *  the same cell count. A header row (all `th`) is padded with `th`. */
function padRows(rows: HElement[]): void {
  const width = Math.max(0, ...rows.map((row) => row.children.length))
  for (const row of rows) {
    if (row.children.length === 0) continue
    const tagName = row.children.every((cell) => isElement(cell, 'th')) ? 'th' : 'td'
    while (row.children.length < width) row.children.push(emptyCell(tagName))
  }
}

/** True if the cell holds block content the GFM plugin cannot put in a cell:
 *  a trigger element, or a paragraph next to other content. Nested tables are
 *  not looked into; they are processed on their own. */
function needsFlattening(node: HNode): boolean {
  const children = node.children ?? []
  for (const child of children) {
    if (!isElement(child) || child.tagName === 'table') continue
    if (FLATTEN_TRIGGERS.has(child.tagName)) return true
    if (child.tagName === 'p' && children.some((other) => other !== child && !isBlankText(other) && other.type !== 'comment')) {
      return true
    }
    if (needsFlattening(child)) return true
  }
  return false
}

/** Flattens block content to inline nodes: list items joined with `; `, other
 *  blocks with a space, `pre` as inline code, `hr` removed. */
function flatten(nodes: HNode[]): HNode[] {
  const pieces: Piece[] = []
  for (const node of nodes) walk(node, pieces)
  return join(pieces)
}

function walk(node: HNode, pieces: Piece[]): void {
  const space: Break = { type: 'break', sep: ' ' }
  if (!isElement(node)) {
    if (node.type === 'text') pieces.push(node)
    return
  }
  const tag = node.tagName

  if (tag === 'hr') {
    pieces.push(space)
    return
  }
  if (tag === 'pre') {
    const code = textContent(node).replace(/\r?\n/g, ' ').trim()
    pieces.push(space)
    if (code) pieces.push({ type: 'element', tagName: 'code', properties: {}, children: [text(code)] } as HElement)
    pieces.push(space)
    return
  }
  if (tag === 'table') {
    pieces.push(space, node, space)
    return
  }
  if (tag === 'ul' || tag === 'ol') {
    pieces.push(space)
    let first = true
    for (const child of node.children) {
      if (isElement(child, 'li')) {
        if (!first) pieces.push({ type: 'break', sep: '; ' })
        first = false
        for (const grandchild of child.children) walk(grandchild, pieces)
      } else {
        walk(child, pieces)
      }
    }
    pieces.push(space)
    return
  }
  if (isDrawing(node)) {
    pieces.push(node)
    return
  }
  if (BLOCK_CONTAINERS.has(tag) || tag === 'li') {
    pieces.push(space)
    const label = tag === 'p' ? calloutLabel(node) : null
    if (label) pieces.push(text(`${label} `))
    for (const child of node.children) walk(child, pieces)
    pieces.push(space)
    return
  }
  // Any other element stays as it is, unless it wraps block content: then it
  // is unwrapped, otherwise the plugin would still keep the table as HTML.
  if (needsFlattening(node)) {
    pieces.push(space)
    for (const child of node.children) walk(child, pieces)
    pieces.push(space)
    return
  }
  pieces.push(node)
}

/** Joins pieces into inline nodes. A run of breaks becomes one separator (the
 *  strongest); blank text next to a break is dropped; leading and trailing
 *  breaks vanish. */
function join(pieces: Piece[]): HNode[] {
  const out: HNode[] = []
  let sep: Break['sep'] | null = null
  let blank: HNode | null = null
  let started = false
  for (const piece of pieces) {
    if (piece.type === 'break') {
      const next = (piece as Break).sep
      sep = sep === '; ' || next === '; ' ? '; ' : ' '
      blank = null
      continue
    }
    if (isBlankText(piece)) {
      if (sep === null) blank = piece
      continue
    }
    if (started) {
      if (sep !== null) out.push(text(sep))
      else if (blank) out.push(blank)
    }
    sep = null
    blank = null
    out.push(piece)
    started = true
  }
  return out
}

function isDrawing(el: HElement): boolean {
  // Unknown attributes keep their name as hast property.
  return el.tagName === 'div' && (classes(el).includes('drawing-manager') || el.properties['drawio-diagram'] !== undefined)
}

/** The inline label of a BookStack callout paragraph, as the callout rule
 *  writes it inside a table cell. */
function calloutLabel(el: HElement): string | null {
  const names = classes(el)
  if (!names.includes('callout')) return null
  for (const type of ['warning', 'danger', 'success', 'info'] as const) {
    if (names.includes(type)) return INLINE_LABEL[type]
  }
  return null
}

function bump(dropped: Record<string, number>, kind: string): void {
  dropped[kind] = (dropped[kind] ?? 0) + 1
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

/** YouTube iframes → Markdown thumbnail links */
function addYouTubeRule(turndown: TurndownService): void {
  turndown.addRule('youtube-embed', {
    filter: (node: HTMLElement) => {
      if (node.nodeName !== 'IFRAME') return false
      const src = node.getAttribute('src') || ''
      return /youtube\.com\/embed\/|youtube-nocookie\.com\/embed\//.test(src)
    },
    replacement: (_content: string, node: Node) => {
      const el = node as HTMLElement
      const src = el.getAttribute('src') || ''
      const videoId = src.match(/embed\/([^?&#]+)/)?.[1]
      if (!videoId) return ''
      return `\n[![YouTube](https://img.youtube.com/vi/${videoId}/maxresdefault.jpg)](https://www.youtube.com/watch?v=${videoId})\n`
    },
  })
}

/** BookStack callouts → GFM alerts (or a plain-text label inside a table cell) */
function addCalloutRule(turndown: TurndownService): void {
  turndown.addRule('bookstack-callout', {
    filter: (node: HTMLElement) => node.nodeName === 'P' && node.classList.contains('callout') && getCalloutType(node) !== null,
    replacement: (content: string, node: Node) => {
      const el = node as HTMLElement
      const type = getCalloutType(el) ?? 'info'
      const text = content.trim()

      // Inside a table cell the block syntax does not work
      if (isInsideTable(el)) {
        const label = INLINE_LABEL[type]
        return text ? `${label} ${text}` : label
      }

      return `\n> [!${ALERT[type]}]\n${quote(text)}\n\n`
    },
  })
}

function isInsideTable(node: HTMLElement): boolean {
  let current = node.parentNode
  while (current) {
    if (current.nodeName === 'TD' || current.nodeName === 'TH') return true
    current = current.parentNode
  }
  return false
}

function getCalloutType(node: HTMLElement): CalloutType | null {
  if (node.classList.contains('warning')) return 'warning'
  if (node.classList.contains('danger')) return 'danger'
  if (node.classList.contains('success')) return 'success'
  if (node.classList.contains('info')) return 'info'
  return null
}

/** Code blocks with language preservation */
function addCodeBlockRule(turndown: TurndownService): void {
  turndown.addRule('fenced-code-with-language', {
    filter: (node: HTMLElement) =>
      node.nodeName === 'PRE' && node.firstChild !== null && node.firstChild.nodeName === 'CODE',
    replacement: (content: string, node: Node) => {
      const codeEl = (node as HTMLElement).querySelector('code')
      if (!codeEl) return content

      const code = codeEl.textContent || ''
      const lang = extractLanguage(codeEl)
      const fence = code.includes('```') ? '````' : '```'

      return `\n${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}\n\n`
    },
  })
}

function extractLanguage(codeEl: Element): string {
  const className = codeEl.getAttribute('class') || ''
  const match = className.match(/language-(\w+)/)
  return match ? match[1]! : ''
}

/**
 * Strip <a> wrappers around <img> tags.
 * BookStack wraps images in links (often to the image itself). Without this
 * rule, turndown produces [![alt](src)](href); this rule outputs ![alt](src).
 */
function addLinkedImageRule(turndown: TurndownService): void {
  turndown.addRule('linked-image', {
    filter: (node: HTMLElement) => {
      if (node.nodeName !== 'A') return false
      const children = node.childNodes
      // <a> with exactly one <img> (whitespace text nodes allowed)
      let imgCount = 0
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!
        if (child.nodeType === 1 && child.nodeName === 'IMG') {
          imgCount++
        } else if (child.nodeType === 3 && (child.textContent || '').trim() !== '') {
          return false
        }
      }
      return imgCount === 1
    },
    replacement: (content: string, node: Node) => {
      const img = (node as HTMLElement).querySelector('img')
      if (!img) return content
      const src = img.getAttribute('src') || ''
      const alt = img.getAttribute('alt') || ''
      return `![${alt}](${src})`
    },
  })
}

/** <details><summary> → a NOTE alert with the summary as bold first line */
function addDetailsSummaryRule(turndown: TurndownService): void {
  // The summary becomes the alert title; drop it from the body.
  turndown.addRule('details-summary-title', {
    filter: (node: HTMLElement) => node.nodeName === 'SUMMARY' && node.parentNode?.nodeName === 'DETAILS',
    replacement: () => '',
  })
  turndown.addRule('details-summary', {
    filter: (node: HTMLElement) => node.nodeName === 'DETAILS',
    replacement: (content: string, node: Node) => {
      const summaryEl = (node as HTMLElement).querySelector('summary')
      const title = (summaryEl?.textContent || '').trim().replace(/\s+/g, ' ') || 'Details'
      const body = content.trim()
      return `\n> [!NOTE] **${title}**\n${body ? `${quote(body)}\n` : ''}\n`
    },
  })
}

/** BookStack internal links → `[text](source:<id>|<url>)` placeholders, or
 *  absolute URLs if the target is not part of the import */
function addInternalLinkRule(turndown: TurndownService, context: ConversionContext): void {
  const base = context.baseUrl.replace(/\/+$/, '')

  const internalPath = (href: string): string | null => {
    let path: string | null = null
    if (href.startsWith(`${base}/`)) path = href.slice(base.length)
    else if (href.startsWith('/') && !href.startsWith('//')) path = href
    return path && /^\/(books|link)\//.test(path) ? path : null
  }

  turndown.addRule('internal-link', {
    filter: (node: HTMLElement) => node.nodeName === 'A' && internalPath(node.getAttribute('href') || '') !== null,
    replacement: (content: string, node: Node) => {
      const href = (node as HTMLElement).getAttribute('href') || ''
      const resolved = context.resolveInternalLink(href)
      if (resolved) return `[${content}](source:${resolved.id}|${resolved.url})`
      return `[${content}](${base}${internalPath(href)})`
    },
  })
}

/** BookStack drawings → the PNG preview as image; the drawing is collected so
 *  the caller can fetch and convert it */
function addDrawingRule(turndown: TurndownService, state: ConversionState): void {
  turndown.addRule('bookstack-drawing', {
    filter: (node: HTMLElement) =>
      node.nodeName === 'DIV' && (node.classList.contains('drawing-manager') || node.hasAttribute('drawio-diagram')),
    replacement: (_content: string, node: Node) => {
      const el = node as HTMLElement
      const id = el.getAttribute('drawio-diagram') || ''
      const img = el.querySelector('img')
      const src = img?.getAttribute('src') || ''
      if (!src) {
        bump(state.dropped, 'drawing')
        return ''
      }
      const alt = img?.getAttribute('alt') || ''
      state.drawings.push({ id, src, alt })
      return `\n![${alt}](${src})\n`
    },
  })
}
