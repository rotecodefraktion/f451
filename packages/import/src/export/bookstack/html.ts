import type { TreeNode } from '../../api.js'
import { parsePage, renderHtml } from '@f451/markdown'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'

export interface HtmlContext {
  /** f451 page id → BookStack page URL for pages in this export (second pass). */
  bookstackUrls: Map<string, string>
  /** Absolute f451 base URL for pages outside the export. */
  f451Url: string
  /** Space of the export, for f451 URLs. */
  space: string
  /** `_media/<name>` → BookStack image URL after upload. */
  imageUrls: Map<string, string>
  /** BookStack image URL → image id, for images that are editable drawings. */
  drawingIds: Map<string, number>
  /** `_media/<name>` → BookStack attachment URL for linked files. */
  attachmentUrls: Map<string, string>
  /** Link target (id, path or title, as in a wikilink) → f451 page id, or
   *  null when no page of the space matches. Built from the space tree. */
  resolvePage(target: string): string | null
}

// Local, minimal hast node types instead of an @types/hast dependency (as in
// adapters/bookstack/html-to-md.ts).
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

/** GFM alert kind → BookStack callout class. */
const CALLOUT: Record<string, string> = {
  note: 'info',
  tip: 'success',
  important: 'warning',
  warning: 'warning',
  caution: 'danger',
}

function isElement(node: HNode | undefined, tagName?: string): node is HElement {
  return node?.type === 'element' && (tagName === undefined || node.tagName === tagName)
}

function classes(el: HElement): string[] {
  const value = el.properties.className
  return Array.isArray(value) ? value.map(String) : []
}

function isBlankText(node: HNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim()
}

function f451PageUrl(ctx: HtmlContext, pageId: string): string {
  const base = ctx.f451Url.replace(/\/+$/, '')
  return `${base}/wiki/${encodeURIComponent(ctx.space)}/${encodeURIComponent(pageId)}`
}

/** The alert kind of `<div class="alert alert-<kind>">`, or null. */
function alertKind(el: HElement): string | null {
  if (el.tagName !== 'div') return null
  const cls = classes(el)
  if (!cls.includes('alert')) return null
  for (const c of cls) {
    const kind = c.startsWith('alert-') ? c.slice('alert-'.length) : null
    if (kind && kind in CALLOUT) return kind
  }
  return null
}

/** `<div class="alert alert-<kind>">` → `<p class="callout <type>">` with the body
 *  paragraphs joined by `<br>`; the title paragraph is dropped (BookStack shows the
 *  type by colour). Block children other than paragraphs (lists, code) cannot live
 *  inside a `<p>` and follow the callout unchanged. */
function toCallout(el: HElement, kind: string): HNode[] {
  const inline: HNode[] = []
  const blocks: HNode[] = []
  for (const child of el.children) {
    if (isBlankText(child)) continue
    if (isElement(child, 'p')) {
      if (classes(child).includes('alert-title')) continue
      if (inline.length > 0) inline.push({ type: 'element', tagName: 'br', properties: {}, children: [] })
      inline.push(...child.children)
    } else {
      blocks.push(child)
    }
  }
  const callout: HElement = {
    type: 'element',
    tagName: 'p',
    properties: { className: ['callout', CALLOUT[kind]!] },
    children: inline,
  }
  return inline.length > 0 ? [callout, ...blocks] : blocks
}

/** The BookStack drawing id of an `<img>` whose src is a drawing, or null. */
function drawingIdOf(node: HNode, drawingIds: Map<string, number>): number | null {
  if (!isElement(node, 'img')) return null
  const src = node.properties.src
  return typeof src === 'string' ? (drawingIds.get(src) ?? null) : null
}

/** `<div drawio-diagram="<id>"><img …></div>`, the markup BookStack's editor
 *  recognises as an editable drawing. */
function drawingBlock(img: HElement, id: number): HElement {
  const properties: Record<string, unknown> = { src: img.properties.src }
  if (img.properties.alt !== undefined) properties.alt = img.properties.alt
  return {
    type: 'element',
    tagName: 'div',
    properties: { 'drawio-diagram': String(id) },
    children: [{ type: 'element', tagName: 'img', properties, children: [] } as HElement],
  }
}

/** Rewrites the children of `node` in place; returns the number of broken links flattened. */
function transform(node: HNode, drawingIds: Map<string, number>): number {
  if (!node.children) return 0
  let broken = 0
  const out: HNode[] = []
  for (const child of node.children) {
    // A drawing alone in a paragraph replaces the paragraph (no div inside p).
    if (isElement(child, 'p')) {
      const content = child.children.filter((c) => !isBlankText(c))
      const only = content.length === 1 ? content[0]! : undefined
      const id = only ? drawingIdOf(only, drawingIds) : null
      if (only && id !== null) {
        out.push(drawingBlock(only as HElement, id))
        continue
      }
    }
    const id = drawingIdOf(child, drawingIds)
    if (id !== null) {
      out.push(drawingBlock(child as HElement, id))
      continue
    }
    broken += transform(child, drawingIds)
    if (isElement(child, 'span') && classes(child).includes('broken-link')) {
      out.push(...child.children)
      broken += 1
      continue
    }
    if (isElement(child)) {
      const kind = alertKind(child)
      if (kind) {
        out.push(...toCallout(child, kind))
        continue
      }
    }
    out.push(child)
  }
  node.children = out
  return broken
}

/** Renders an f451 page as BookStack page HTML. Links to pages of this export point at
 *  BookStack, links to other known f451 pages at f451, everything else becomes plain
 *  text and is counted in `brokenLinks`. */
export function renderForBookStack(
  markdown: string,
  _pageId: string,
  ctx: HtmlContext,
): { html: string; brokenLinks: number } {
  const rendered = renderHtml(withoutLeadHeading(markdown), {
    resolveLink(raw) {
      const media = raw.replace(/^\.\//, '')
      if (media.startsWith('_media/')) {
        const href = ctx.attachmentUrls.get(media) ?? ctx.imageUrls.get(media)
        return href ? { href } : null
      }
      const id = ctx.resolvePage(raw.split('#')[0]!.trim())
      if (!id) return null
      return { href: ctx.bookstackUrls.get(id) ?? f451PageUrl(ctx, id) }
    },
    resolveImage(src) {
      const key = src.replace(/^\.\//, '')
      if (!key.startsWith('_media/')) return src
      return ctx.imageUrls.get(key) ?? src
    },
  })

  const root = fromHtml(rendered, { fragment: true }) as unknown as HNode
  const brokenLinks = transform(root, ctx.drawingIds)
  return { html: toHtml(root as never), brokenLinks }
}

/** Resolves a link target the way the f451 indexer does: page id, then path
 *  (`<target>/index.md`), then title (case-insensitive, shortest path wins). */
export function pageResolver(nodes: TreeNode[]): (target: string) => string | null {
  const byId = new Map<string, string>()
  const byPath = new Map<string, string>()
  const byTitle = new Map<string, { id: string; path: string }>()
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      byId.set(n.id, n.id)
      byPath.set(n.path, n.id)
      const key = n.title.toLowerCase()
      const hit = byTitle.get(key)
      if (!hit || n.path.length < hit.path.length || (n.path.length === hit.path.length && n.path < hit.path)) {
        byTitle.set(key, { id: n.id, path: n.path })
      }
      walk(n.children)
    }
  }
  walk(nodes)
  return (target) => {
    const t = target.replace(/^\.\//, '').replace(/\/$/, '')
    if (!t) return null
    return byId.get(t) ?? byPath.get(`${t}/index.md`) ?? byPath.get(t) ?? byTitle.get(t.toLowerCase())?.id ?? null
  }
}

/** BookStack shows the page name as the title, so a first `# Title` that
 *  repeats it is dropped; any other first heading stays. */
export function withoutLeadHeading(markdown: string): string {
  const title = parsePage(markdown).title?.trim()
  if (!title) return markdown
  const fm = /^---\n[\s\S]*?\n---\n/.exec(markdown)
  const head = fm ? fm[0] : ''
  const body = markdown.slice(head.length)
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body)
  if (!m || m[1]!.trim() !== title) return markdown
  return head + body.slice(m[0].length)
}
