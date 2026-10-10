import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { visit, SKIP } from 'unist-util-visit'
import type { Root, Html, Text } from 'mdast'

const TAG = /^<\/?([a-zA-Z][\w-]*|!--)/

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
        const text = node.value.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')
        if (text.trim() === '') {
          parent.children.splice(index, 1)
          return [SKIP, index]
        }
        const replacement: Text = { type: 'text', value: text }
        parent.children.splice(index, 1, replacement)
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
