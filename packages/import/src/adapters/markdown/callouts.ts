import type { Root, Blockquote, Paragraph, PhrasingContent, Text } from 'mdast'
import { visit } from 'unist-util-visit'

type Alert = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

const TYPES: Record<Alert, string[]> = {
  NOTE: ['note', 'info', 'abstract', 'summary', 'tldr', 'todo', 'example', 'quote', 'cite'],
  TIP: ['tip', 'hint', 'success', 'check', 'done'],
  IMPORTANT: ['important', 'question', 'help', 'faq'],
  WARNING: ['warning', 'caution', 'attention', 'bug'],
  CAUTION: ['danger', 'error', 'failure', 'fail', 'missing'],
}

const ALERT_OF = new Map<string, Alert>(
  Object.entries(TYPES).flatMap(([alert, names]) => names.map((n) => [n, alert as Alert] as const)),
)

/** Obsidian callout type → GFM alert; unknown types become NOTE. */
export function alertFor(type: string): Alert {
  return ALERT_OF.get(type.toLowerCase()) ?? 'NOTE'
}

const MARKER = /^\[!([^\]\s]+)\]([+-]?)[ \t]*/

/** Splits inline content at the first line end: the nodes before it, the rest after. */
function splitFirstLine(nodes: PhrasingContent[]): { first: PhrasingContent[]; rest: PhrasingContent[] } {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.type === 'break') return { first: nodes.slice(0, i), rest: nodes.slice(i + 1) }
    if (n.type === 'text') {
      const nl = n.value.indexOf('\n')
      if (nl >= 0) {
        const before: Text = { type: 'text', value: n.value.slice(0, nl) }
        const after: Text = { type: 'text', value: n.value.slice(nl + 1) }
        return {
          first: [...nodes.slice(0, i), ...(before.value ? [before] : [])],
          rest: [...(after.value ? [after] : []), ...nodes.slice(i + 1)],
        }
      }
    }
  }
  return { first: nodes, rest: [] }
}

/** Remark pass: `> [!type]± Title` blockquotes become GFM alerts
 *  (`> [!NOTE]`). The fold marker is dropped; a custom title becomes a bold
 *  first line. */
export function convertCallouts(tree: Root): void {
  visit(tree, 'blockquote', (quote: Blockquote) => {
    const para = quote.children[0]
    if (!para || para.type !== 'paragraph') return
    const head = para.children[0]
    if (!head || head.type !== 'text') return
    const m = MARKER.exec(head.value)
    if (!m) return
    const alert = alertFor(m[1])
    const remaining: PhrasingContent[] = [
      ...(head.value.length > m[0].length ? [{ type: 'text', value: head.value.slice(m[0].length) } as Text] : []),
      ...para.children.slice(1),
    ]
    const { first, rest } = splitFirstLine(remaining)
    const hasTitle = first.some((n) => n.type !== 'text' || n.value.trim() !== '')
    const children: PhrasingContent[] = [{ type: 'text', value: `[!${alert}]` }]
    if (hasTitle) {
      const last = first[first.length - 1]
      if (last && last.type === 'text') last.value = last.value.replace(/\s+$/, '')
      children.push({ type: 'text', value: '\n' }, { type: 'strong', children: first })
    }
    if (rest.length) children.push({ type: 'text', value: '\n' }, ...rest)
    const replaced: Paragraph = { type: 'paragraph', children }
    quote.children[0] = replaced
  })
}
