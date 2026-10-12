import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkWikiLink from 'remark-wiki-link'
import { visitParents } from 'unist-util-visit-parents'
import { parseFrontmatterBlock } from './frontmatter.js'
import { createSlugger } from './slug.js'
import type {
  ExtractedLink,
  PageFrontmatter,
  PageHeading,
  ParseOptions,
  ParsedPage,
} from './types.js'

// Lokale, minimale mdast-Node-Typen statt einer Dependency auf @types/mdast — das
// Paket deklariert nur die Felder, die parsePage tatsächlich liest.

/** mdast-Node von remark-wiki-link — kein offizieller mdast-Typ vorhanden.
 *  data.alias ist immer gesetzt (fällt auf value zurück, wenn kein Alias im Dokument steht). */
interface WikiLinkNode {
  type: 'wikiLink'
  value: string
  data?: { alias?: string }
}

interface YamlNode {
  type: 'yaml'
  value: string
}

interface LinkNode {
  type: 'link'
  url: string
  children?: unknown[]
}

interface HeadingNode {
  type: 'heading'
  depth: 1 | 2 | 3 | 4 | 5 | 6
  children?: unknown[]
}

/** Der EINE geteilte Parse-Prozessor des Pakets — parsePage (hier) UND
 *  parseMarkdownTree (stringify.ts, Phase 2b Task 1) nutzen ihn, damit der Editor exakt
 *  denselben mdast-Baum sieht wie die Lese-Pipeline (kein zweiter, abweichend
 *  konfigurierter Parser). */
export const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkWikiLink, { aliasDivider: '|' })

/** Extrahiert den sichtbaren Text eines Inline-Knotens rekursiv
 *  (mdast-util-to-string-Logik, aber ohne die Dependency). */
function textFromNode(node: {
  type: string
  value?: string
  data?: { alias?: string }
  children?: unknown[]
}): string {
  if (node.type === 'wikiLink') return node.data?.alias ?? node.value ?? ''
  if (typeof node.value === 'string') return node.value
  if (Array.isArray(node.children)) {
    return node.children.map((child) => textFromNode(child as typeof node)).join('')
  }
  return ''
}

function isExcludedUrl(url: string): boolean {
  return url.includes('://') || url.startsWith('#') || url.startsWith('mailto:')
}

type TextNode = Parameters<typeof textFromNode>[0]

/** Block types whose plain text serves as the context of a link inside them. */
const CONTEXT_BLOCK_TYPES = new Set(['paragraph', 'heading', 'tableCell'])

/** Plain text of `block` (same rules as textFromNode) plus the offsets at which
 *  `target` starts and ends in it. Walking the tree — rather than searching the text —
 *  picks the right occurrence when the link text appears more than once. */
function blockTextWithSpan(
  block: TextNode,
  target: unknown,
): { text: string; start: number; end: number } {
  let text = ''
  let start = -1
  let end = -1
  const walk = (node: TextNode): void => {
    if (node === target) {
      start = text.length
      text += textFromNode(node)
      end = text.length
      return
    }
    if (node.type === 'wikiLink' || typeof node.value === 'string') {
      text += textFromNode(node)
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child as TextNode)
    }
  }
  walk(block)
  return { text, start, end }
}

/** `ExtractedLink.context` of a link node: excerpt of its nearest enclosing paragraph,
 *  heading or table cell; '' without such a block. */
function contextOf(node: unknown, ancestors: readonly unknown[]): string {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i] as TextNode
    if (CONTEXT_BLOCK_TYPES.has(ancestor.type)) {
      const { text, start, end } = blockTextWithSpan(ancestor, node)
      return start < 0 ? '' : linkContext(text, start, end)
    }
  }
  return ''
}

const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ')

/** Short plain-text excerpt around `block.slice(start, end)` (the link text).
 *  Whitespace runs collapse to single spaces; up to `radius` chars are kept on each
 *  side of the link text. A cut never splits a word — the partial word is dropped —
 *  and '…' marks each side where text was actually cut. */
export function linkContext(block: string, start: number, end: number, radius = 80): string {
  let before = collapseWhitespace(block.slice(0, start)).trimStart()
  const link = collapseWhitespace(block.slice(start, end))
  let after = collapseWhitespace(block.slice(end)).trimEnd()

  if (before.length > radius) {
    const cut = before.length - radius
    let tail = before.slice(cut)
    if (before[cut - 1] !== ' ' && tail[0] !== ' ') {
      const space = tail.indexOf(' ')
      tail = space === -1 ? '' : tail.slice(space + 1)
    }
    before = '…' + tail.trimStart()
  }

  if (after.length > radius) {
    let head = after.slice(0, radius)
    if (after[radius] !== ' ' && head[radius - 1] !== ' ') {
      const space = head.lastIndexOf(' ')
      head = space === -1 ? '' : head.slice(0, space)
    }
    after = head.trimEnd() + '…'
  }

  return before + link + after
}

/** Parst Markdown zu einer ParsedPage: Frontmatter (via Task 1), Wikilinks und relative
 *  Links (keine externen, Anker- oder mailto-Links, keine Bilder), Headings mit Slugs
 *  sowie den Titel (frontmatter.title gewinnt, sonst erstes H1, sonst undefined).
 *  Wirft nie — Frontmatter-Fehler werden aus Task 1 durchgereicht. */
export function parsePage(markdown: string, opts?: ParseOptions): ParsedPage {
  const tree = markdownProcessor.parse(markdown)
  const slugger = createSlugger()

  let frontmatter: PageFrontmatter = { tags: [], relations: {} }
  let frontmatterErrors: string[] = []
  const links: ExtractedLink[] = []
  const headings: PageHeading[] = []
  let firstH1: string | undefined

  visitParents(tree, (node, ancestors) => {
    // remark-wiki-link führt den Node-Typ 'wikiLink' ein, der in @types/mdast nicht
    // deklariert ist — daher die Typvergleiche hier über den unnarrowed string.
    const type: string = node.type

    if (type === 'yaml') {
      const result = parseFrontmatterBlock((node as unknown as YamlNode).value, opts)
      frontmatter = result.frontmatter
      frontmatterErrors = result.errors
      return
    }

    if (type === 'wikiLink') {
      const wikiLink = node as unknown as WikiLinkNode
      links.push({
        rawTarget: wikiLink.value,
        kind: 'wikilink',
        text: wikiLink.data?.alias ?? wikiLink.value,
        context: contextOf(node, ancestors),
      })
      return
    }

    if (type === 'link') {
      const link = node as unknown as LinkNode
      if (!isExcludedUrl(link.url)) {
        links.push({
          rawTarget: link.url,
          kind: 'relative',
          text: textFromNode(link),
          context: contextOf(node, ancestors),
        })
      }
      return
    }

    if (type === 'heading') {
      const heading = node as unknown as HeadingNode
      const text = textFromNode(heading)
      const slug = slugger(text)
      headings.push({ depth: heading.depth, text, slug })
      if (heading.depth === 1 && firstH1 === undefined) firstH1 = text
    }
  })

  return {
    frontmatter,
    frontmatterErrors,
    title: frontmatter.title ?? firstH1,
    links,
    headings,
  }
}
