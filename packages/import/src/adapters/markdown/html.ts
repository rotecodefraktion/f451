import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'

// Local, minimal hast node types instead of an @types/hast dependency (as in
// the BookStack converter).
interface HNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
  value?: string
}

/** Page chrome and interactive elements, removed inside the content root. */
const CHROME = new Set([
  'nav',
  'header',
  'footer',
  'aside',
  'script',
  'style',
  'noscript',
  'template',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
])

const CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i
const latin1 = new TextDecoder('latin1')

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/** The decoder for the declared charset, or UTF-8 when there is no
 *  declaration or `TextDecoder` does not know the label. A BOM means UTF-8. */
function decoderFor(bytes: Uint8Array): TextDecoder {
  if (!hasBom(bytes)) {
    const label = CHARSET.exec(latin1.decode(bytes.subarray(0, 1024)))?.[1]
    if (label) {
      try {
        return new TextDecoder(label, { fatal: true })
      } catch (e) {
        if (!(e instanceof RangeError)) throw e
      }
    }
  }
  return new TextDecoder('utf-8', { fatal: true })
}

function decodeHtml(bytes: Uint8Array): string {
  const body = hasBom(bytes) ? bytes.subarray(3) : bytes
  const decoder = decoderFor(bytes)
  try {
    return decoder.decode(body)
  } catch {
    throw new Error(`not decodable as ${decoder.encoding}`)
  }
}

function isElement(node: HNode, tagName?: string): boolean {
  return node.type === 'element' && (tagName === undefined || node.tagName === tagName)
}

/** First element with the tag in document order. */
function findFirst(node: HNode, tagName: string): HNode | null {
  for (const child of node.children ?? []) {
    if (isElement(child, tagName)) return child
    const hit = findFirst(child, tagName)
    if (hit) return hit
  }
  return null
}

function textOf(node: HNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function collapsed(node: HNode | null): string {
  return node ? textOf(node).replace(/\s+/g, ' ').trim() : ''
}

function isHidden(node: HNode): boolean {
  const p = node.properties ?? {}
  const hidden = p.hidden
  if (hidden !== undefined && hidden !== null && hidden !== false) return true
  const aria = p.ariaHidden
  return aria === true || String(aria).toLowerCase() === 'true'
}

function stripChrome(node: HNode): void {
  if (!node.children) return
  node.children = node.children.filter(
    (child) => !(child.type === 'element' && (CHROME.has(child.tagName ?? '') || isHidden(child))),
  )
  for (const child of node.children) stripChrome(child)
}

/** Reads one HTML file: decodes it, takes the title (`<title>`, else the first
 *  `<h1>`, else `fallbackTitle`) and returns the content root (`<main>`, else
 *  `<article>`, else `<body>`) without page chrome, serialised as HTML.
 *  Throws `not decodable as <charset>` on bytes the charset cannot decode. */
export function readHtmlNote(bytes: Uint8Array, fallbackTitle: string): { title: string; html: string } {
  const doc = fromHtml(decodeHtml(bytes)) as unknown as HNode
  const title = collapsed(findFirst(doc, 'title')) || collapsed(findFirst(doc, 'h1')) || fallbackTitle
  const root = findFirst(doc, 'main') ?? findFirst(doc, 'article') ?? findFirst(doc, 'body')
  const content: HNode = root ? { type: 'root', children: root.children ?? [] } : doc
  stripChrome(content)
  return { title, html: toHtml(content as never) }
}
