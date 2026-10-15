// Escaped alias divider of wikilinks in GFM table cells.
//
// Inside a table cell an unescaped `|` splits the cell, so a wikilink with alias is
// written `[[target\|alias]]` there (GitHub/Obsidian convention). remark-wiki-link does
// not know this escape: it cuts the target at the `|` and keeps the backslash, yielding
// target `target\`. This plugin repairs both directions and must be `.use`d right
// after remarkWikiLink:
//
// - Parsing: a from-markdown transform drops the trailing backslash of the target. It
//   runs inside the parser itself, so `processor.parse()` (parsePage,
//   parseMarkdownTree) sees the repaired tree, not only `run()`/`process()`.
// - Writing: the wikiLink to-markdown handler of remark-wiki-link is wrapped so that
//   inside a table cell the divider is written as `\|`; elsewhere output is unchanged.

import type { Processor } from 'unified'
import type { Handle } from 'mdast-util-to-markdown'

interface WikiLinkNode {
  type: 'wikiLink'
  value: string
  data?: { alias?: string }
}

interface TreeNode {
  type: string
  children?: TreeNode[]
}

/** Drops the backslash left at the end of a wikilink target by an escaped alias divider
 *  (`[[target\|alias]]`). Only wikilinks that carry an alias are touched — without an
 *  alias there was no divider to escape. The alias stays as parsed. */
export function unescapeWikiLinkDividers(tree: TreeNode): void {
  const walk = (node: TreeNode): void => {
    if (node.type === 'wikiLink') {
      const link = node as unknown as WikiLinkNode
      const alias = link.data?.alias
      if (typeof link.value === 'string' && link.value.endsWith('\\') && alias !== undefined && alias !== link.value) {
        link.value = link.value.slice(0, -1)
      }
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child)
    }
  }
  walk(tree)
}

/** First alias divider `|` of a serialised wikilink that is not already escaped; the
 *  target part may contain backslash escapes, which are skipped pairwise. */
const BARE_DIVIDER = /^(\[\[(?:[^|\\]|\\.)*)\|/

interface ToMarkdownExtension {
  handlers?: Record<string, Handle>
}

/** remark plugin — use directly after `remarkWikiLink` (see file comment). */
export function remarkWikiLinkTableCells(this: Processor): void {
  // Same registration pattern as remark-wiki-link itself (untyped data fields).
  const data = this.data() as unknown as Record<string, unknown[] | undefined>
  const fromMarkdown = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = [])
  const toMarkdown = (data.toMarkdownExtensions ?? (data.toMarkdownExtensions = [])) as ToMarkdownExtension[]

  fromMarkdown.push({
    transforms: [
      (tree: TreeNode) => {
        unescapeWikiLinkDividers(tree)
      },
    ],
  })

  const original = [...toMarkdown].reverse().find((ext) => ext.handlers?.wikiLink)?.handlers?.wikiLink
  if (!original) return

  const wikiLink: Handle = (node, parent, state, info) => {
    const value = original(node, parent, state, info)
    return state.stack.includes('tableCell') ? value.replace(BARE_DIVIDER, '$1\\|') : value
  }
  toMarkdown.push({ handlers: { wikiLink } })
}
