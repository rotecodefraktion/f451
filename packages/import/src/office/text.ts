// Pre-pass on LibreOffice's Writer HTML (spec 2026-10-16-office-import §3
// "Text documents"): footnotes and endnotes, comments and tracked changes,
// heading numbering lists, nested lists, and the cut at H1 for a split.

import { htmlToMarkdown } from '../adapters/bookstack/html-to-md.js'
import { label, type Lang, type OfficeDoc, type OfficePart } from './doc.js'
import {
  collapse,
  findAll,
  isElement,
  prop,
  promoteHeader,
  removeWhere,
  serialize,
  textOf,
  txt,
  unwrapWhere,
  type HElement,
  type HNode,
} from './hast.js'
import { normaliseLists, unwrapHeadingLists } from './lists.js'
import { stripTokens, type Tokens } from './tokens.js'

export interface PrepassContext {
  tokens: Tokens
  dropped: Record<string, number>
  lang: Lang
}

const NOTE_BODY = /^sd(foot|end)note(\d+)$/
const NOTE_ANCHOR = /^sd(foot|end)note(\d+)anc$/
const NOTE_SYMBOL = /^sd(foot|end)note(\d+)sym$/

function bump(map: Record<string, number>, key: string, n = 1): void {
  if (n > 0) map[key] = (map[key] ?? 0) + n
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) bump(into, k, n)
}

/** Footnote and endnote anchors become footnote tokens; the note bodies at
 *  the end of the document are converted on their own and removed. */
function convertNotes(body: HElement, ctx: PrepassContext): void {
  const bodies = new Map<string, HElement>()
  removeWhere(body, (n) => {
    if (!isElement(n, 'div')) return false
    const m = NOTE_BODY.exec(prop(n, 'id'))
    if (!m) return false
    bodies.set(`${m[1]}${m[2]}`, n)
    return true
  })

  const replace = (node: HNode): void => {
    if (!node.children) return
    const out: HNode[] = []
    for (const c of node.children) {
      const m = isElement(c, 'a') ? NOTE_ANCHOR.exec(prop(c, 'name')) : null
      if (!m || !isElement(c)) {
        replace(c)
        out.push(c)
        continue
      }
      const note = bodies.get(`${m[1]}${m[2]}`)
      if (!note) {
        out.push(...c.children)
        continue
      }
      removeWhere(note, (n) => isElement(n, 'a') && NOTE_SYMBOL.test(prop(n, 'name')))
      const converted = htmlToMarkdown(serialize(note.children), { baseUrl: '', resolveInternalLink: () => null })
      mergeCounts(ctx.dropped, converted.dropped)
      const noteLabel = m[1] === 'foot' ? m[2] : `e${m[2]}`
      out.push(txt(ctx.tokens.footnote(noteLabel, converted.markdown.trim())))
    }
    node.children = out
  }
  replace(body)
}

/** The body's blocks with wrapping `div`s (sections, header, footer) unwrapped. */
function topLevel(nodes: HNode[]): HNode[] {
  return nodes.flatMap((n) => (isElement(n, 'div') ? topLevel(n.children) : [n]))
}

export function textPrepass(body: HElement, ctx: PrepassContext): OfficeDoc {
  // Writer writes comments (annotations) as HTML comments.
  bump(ctx.dropped, 'comment', removeWhere(body, (n) => n.type === 'comment'))
  // Tracked changes: deletions go, insertions stay as plain text.
  bump(ctx.dropped, 'trackedChange', removeWhere(body, (n) => isElement(n, 'del')))
  bump(ctx.dropped, 'trackedChange', unwrapWhere(body, (e) => e.tagName === 'ins'))

  convertNotes(body, ctx)
  unwrapHeadingLists(body)
  normaliseLists(body, false)
  for (const table of findAll(body, (e) => e.tagName === 'table')) promoteHeader(table)

  const blocks = topLevel(body.children)
  const intro: HNode[] = []
  const parts: Array<{ heading: HElement; nodes: HNode[] }> = []
  for (const n of blocks) {
    if (isElement(n, 'h1')) parts.push({ heading: n, nodes: [] })
    else if (parts.length) parts[parts.length - 1].nodes.push(n)
    else intro.push(n)
  }
  return {
    intro: serialize(intro),
    parts: parts.map(
      (p, i): OfficePart => ({
        title: collapse(stripTokens(textOf(p.heading))) || `${label('chapter', ctx.lang)} ${i + 1}`,
        heading: serialize([p.heading]),
        html: serialize(p.nodes),
      }),
    ),
  }
}
