// Small hast helpers for the Office pre-passes. Local node types instead of an
// @types/hast dependency, as in `adapters/bookstack/html-to-md.ts`.

import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'

export interface HNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
  value?: string
}

export interface HElement extends HNode {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HNode[]
}

export function isElement(node: HNode | undefined, tagName?: string): node is HElement {
  return node?.type === 'element' && (tagName === undefined || node.tagName === tagName)
}

export function isList(node: HNode | undefined): node is HElement {
  return isElement(node, 'ul') || isElement(node, 'ol')
}

export function el(tagName: string, properties: Record<string, unknown> = {}, children: HNode[] = []): HElement {
  return { type: 'element', tagName, properties, children }
}

export function txt(value: string): HNode {
  return { type: 'text', value }
}

export function textOf(node: HNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'comment') return ''
  return (node.children ?? []).map(textOf).join('')
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function prop(node: HElement, name: string): string {
  const v = node.properties[name]
  if (Array.isArray(v)) return v.join(' ')
  return v === undefined || v === null ? '' : String(v)
}

export function classList(node: HElement): string[] {
  const v = node.properties.className
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/\s+/) : []
}

/** All descendant elements matching `pred`, in document order. */
export function findAll(node: HNode, pred: (e: HElement) => boolean): HElement[] {
  const out: HElement[] = []
  const visit = (n: HNode): void => {
    for (const c of n.children ?? []) {
      if (isElement(c) && pred(c)) out.push(c)
      visit(c)
    }
  }
  visit(node)
  return out
}

/** Removes every descendant matching `pred` (not descending into it); returns how many. */
export function removeWhere(node: HNode, pred: (n: HNode) => boolean): number {
  let count = 0
  const visit = (n: HNode): void => {
    if (!n.children) return
    const kept: HNode[] = []
    for (const c of n.children) {
      if (pred(c)) count++
      else {
        visit(c)
        kept.push(c)
      }
    }
    n.children = kept
  }
  visit(node)
  return count
}

/** Replaces every descendant element matching `pred` by its children; returns how many. */
export function unwrapWhere(node: HNode, pred: (e: HElement) => boolean): number {
  let count = 0
  const visit = (n: HNode): void => {
    if (!n.children) return
    const out: HNode[] = []
    for (const c of n.children) {
      visit(c)
      if (isElement(c) && pred(c)) {
        count++
        out.push(...c.children)
      } else out.push(c)
    }
    n.children = out
  }
  visit(node)
  return count
}

/** True if the node shows nothing: no text, no image, no table cell with text. */
export function isBlank(node: HNode): boolean {
  if (node.type === 'comment' || node.type === 'doctype') return true
  if (node.type === 'text') return (node.value ?? '').trim() === ''
  if (isElement(node, 'img')) return false
  if (textOf(node).trim() !== '') return false
  return findAll(node, (e) => e.tagName === 'img').length === 0
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const SELF_CLOSING = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/>/g

/** XHTML self-closing tags (`<div/>`, `<span …/>`) mean "empty element", but
 *  the HTML parser reads them as start tags. Expands them for non-void elements. */
export function expandSelfClosing(xhtml: string): string {
  return xhtml.replace(SELF_CLOSING, (all, tag: string, attrs: string) =>
    VOID.has(tag.toLowerCase()) ? all : `<${tag}${attrs}></${tag}>`,
  )
}

/** Parses a whole HTML document and returns its `body` element. */
export function parseBody(html: string): HElement {
  const root = fromHtml(html) as unknown as HNode
  const body = findAll(root, (e) => e.tagName === 'body')[0]
  return body ?? el('body', {}, root.children ?? [])
}

export function serialize(nodes: HNode[]): string {
  return toHtml({ type: 'root', children: nodes } as never)
}

/** Header row: the first row's cells become `th` in a `thead`, unless the
 *  table already has a `thead` or a `th`. Gives a GFM table a real header. */
export function promoteHeader(table: HElement): void {
  if (findAll(table, (e) => e.tagName === 'thead' || e.tagName === 'th').length) return
  const rows: HElement[] = []
  for (const c of table.children) {
    if (isElement(c, 'tr')) rows.push(c)
    else if (isElement(c, 'tbody') || isElement(c, 'tfoot')) rows.push(...c.children.filter((r): r is HElement => isElement(r, 'tr')))
  }
  if (rows.length < 2) return
  const [head, ...body] = rows
  for (const cell of head.children) if (isElement(cell, 'td')) cell.tagName = 'th'
  table.children = [el('thead', {}, [head]), el('tbody', {}, body)]
}
