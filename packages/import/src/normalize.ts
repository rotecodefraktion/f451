import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { visit, SKIP } from 'unist-util-visit'
import type { Root, Html, Paragraph, Text } from 'mdast'
import { fromHtml } from 'hast-util-from-html'

const TAG = /^<\/?([a-zA-Z][\w-]*|!--)/
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

interface HtmlNode {
  type: string
  value?: string
  children?: HtmlNode[]
}

/** Text content of an HTML fragment, read with an HTML parser rather than by
 *  stripping tags with regular expressions; comments contribute nothing. */
function htmlText(html: string): string {
  const collect = (node: HtmlNode): string =>
    node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(collect).join('')
  return collect(fromHtml(html, { fragment: true }) as HtmlNode)
}

/** Reduces Markdown to CommonMark + GFM. Raw HTML becomes its text content
 *  (comments vanish); every dropped construct is counted by tag name. */
export function normalizeMarkdown(markdown: string): { markdown: string; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: Root) => {
      visit(tree, 'html', (node: Html, index, parent) => {
        const tag = TAG.exec(node.value)?.[1] ?? 'html'
        // A closing tag belongs to an opening one already counted.
        if (!node.value.startsWith('</')) dropped[tag] = (dropped[tag] ?? 0) + 1
        if (!parent || index === undefined) return
        const text = htmlText(node.value)
        if (text.trim() === '') {
          parent.children.splice(index, 1)
          return [SKIP, index]
        }
        const textNode: Text = { type: 'text', value: text }
        // Block HTML sits directly in a flow container. Its text goes into a
        // paragraph, where the serializer escapes `<` that could start a tag.
        const replacement: Text | Paragraph = BLOCK_PARENTS.has(parent.type)
          ? { type: 'paragraph', children: [textNode] }
          : textNode
        parent.children.splice(index, 1, replacement as never)
        return [SKIP, index + 1]
      })
      // A paragraph that only held a comment is now empty; remove it.
      visit(tree, 'paragraph', (node, index, parent) => {
        if (node.children.length === 0 && parent && index !== undefined) {
          parent.children.splice(index, 1)
          return [SKIP, index]
        }
      })
    })
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      emphasis: '*',
      strong: '*',
      rule: '-',
      listItemIndent: 'one',
    })
  // remark-stringify escapes the alert marker (`\\[!NOTE]`); f451 renders the
  // unescaped GFM form, so restore it.
  const out = String(processor.processSync(markdown)).replace(
    /^((?:> ?)+)\\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gm,
    '$1[!$2]',
  )
  return { markdown: out, dropped }
}
