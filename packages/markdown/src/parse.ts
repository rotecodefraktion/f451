import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkWikiLink from 'remark-wiki-link'
import { visit } from 'unist-util-visit'
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

  visit(tree, (node) => {
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
      })
      return
    }

    if (type === 'link') {
      const link = node as unknown as LinkNode
      if (!isExcludedUrl(link.url)) {
        links.push({ rawTarget: link.url, kind: 'relative', text: textFromNode(link) })
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
