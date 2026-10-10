// Adapted from BookBridge (github.com/rotecodefraktion/bookbridge)

import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

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

  countSpans(html, state.dropped)
  const turndown = createTurndownService(context, state)

  try {
    return { markdown: turndown.turndown(html), ...state }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`HTML conversion failed: ${message}`, { cause: error })
  }
}

/** Cells spanning several rows or columns: the GFM plugin flattens them, so
 *  the layout changes. Counted per attribute. */
function countSpans(html: string, dropped: Record<string, number>): void {
  for (const attr of ['colspan', 'rowspan']) {
    const pattern = new RegExp(`<t[dh]\\b[^>]*\\b${attr}\\s*=\\s*["']?\\s*(\\d+)`, 'gi')
    let n = 0
    for (const m of html.matchAll(pattern)) {
      if (Number(m[1]) > 1) n++
    }
    if (n > 0) dropped[attr] = (dropped[attr] ?? 0) + n
  }
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
