// Pre-pass on LibreOffice's Writer HTML (spec 2026-10-16-office-import §3
// "Text documents"): footnotes and endnotes, comments and tracked changes,
// heading numbering lists, nested lists, and the cut at H1 for a split.

import { htmlToMarkdown } from '../adapters/bookstack/html-to-md.js'
import { label, type Lang, type OfficeDoc, type OfficePart } from './doc.js'
import {
  collapse,
  el,
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
import {
  HEADING_LINK,
  headingToken,
  markedLevel,
  stripMarks,
  stripTokens,
  takeHeadingTokens,
  TITLE_TOKEN,
  type Tokens,
} from './tokens.js'

export interface PrepassContext {
  tokens: Tokens
  dropped: Record<string, number>
  lang: Lang
  /** All headings one level down (H1 → H2): on a single page the page title
   *  is the only H1, and the outline starts at H2. */
  shiftHeadings?: boolean
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

/** Writer's table of contents section. The wiki shows its own outline, and
 *  the entries' page numbers mean nothing on a web page. */
const TOC_SECTION = /^(Table of Contents|Inhaltsverzeichnis)\d*$/
/** h7 and deeper exist only inside the pre-pass (from the package marks);
 *  `flattenDeepHeadings` turns them into bold paragraphs at the end. */
const HEADING = /^h\d+$/
/** Elements the package marks can end up in. */
const MARKED_BLOCK = /^(p|h\d+)$/
/** Writer's page header and footer: repeated on every printed page. */
const PAGE_FURNITURE = /^(header|footer)$/
/** A drawing shape Writer rendered as a bitmap under its default name
 *  (backgrounds, lines, decoration); pictures keep their own names. */
const SHAPE_IMAGE = /^Shape\d+$/
// C0 controls other than tab and line breaks (Word fields leave some behind).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function stripControls(node: HNode): void {
  if (node.type === 'text' && node.value) node.value = node.value.replace(CONTROL, '')
  for (const c of node.children ?? []) stripControls(c)
}

/** Inserts `s` after the first `offset` characters of `node`'s text. */
function insertText(node: HNode, offset: number, s: string): void {
  let left = offset
  const visit = (n: HNode): boolean => {
    if (n.type === 'text') {
      const v = n.value ?? ''
      if (left <= v.length) {
        n.value = v.slice(0, left) + s + v.slice(left)
        return true
      }
      left -= v.length
      return false
    }
    return (n.children ?? []).some(visit)
  }
  visit(node)
}

function headingLevel(h: HElement): number {
  return Number(h.tagName.slice(1))
}

/** Applies `fn` to every text node below `node`. */
function editText(node: HNode, fn: (s: string) => string): void {
  if (node.type === 'text' && node.value) node.value = fn(node.value)
  for (const c of node.children ?? []) editText(c, fn)
}

/** Text of `node` with each line break as a space. */
function textWithBreaks(node: HNode): string {
  if (isElement(node, 'br')) return ' '
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'comment') return ''
  return (node.children ?? []).map(textWithBreaks).join('')
}

/** The package pass marked the Title paragraph and paragraphs with outline
 *  level 7 or deeper, which LibreOffice writes as plain paragraphs. The
 *  title paragraph leaves the body and its text is returned; a marked
 *  paragraph becomes a heading of its level. */
function applyMarks(body: HElement): string | undefined {
  let title: string | undefined
  const titleBlock = findAll(body, (e) => MARKED_BLOCK.test(e.tagName) && textOf(e).includes(TITLE_TOKEN))[0]
  if (titleBlock) {
    title = collapse(stripTokens(textWithBreaks(titleBlock))) || undefined
    removeWhere(body, (n) => n === titleBlock)
  }
  for (const e of findAll(body, (x) => MARKED_BLOCK.test(x.tagName))) {
    const level = markedLevel(textOf(e))
    if (level !== null) e.tagName = `h${level}`
  }
  editText(body, stripMarks)
  return title
}

/** Headings past level 6 have no Markdown form: each becomes a paragraph in
 *  bold, so it stays apart from the level above. Its link token goes too, so
 *  links to it keep only their text. */
function flattenDeepHeadings(body: HElement, dropped: Record<string, number>): void {
  for (const h of findAll(body, (e) => HEADING.test(e.tagName) && headingLevel(e) > 6)) {
    editText(h, (s) => takeHeadingTokens(s).text)
    h.tagName = 'p'
    h.properties = {}
    h.children = [el('strong', {}, h.children)]
    bump(dropped, 'headingTooDeep')
  }
}

/** Word's outline numbers reach the HTML glued to the heading text
 *  ("3.1General"). A number counts as outline number when it has as many
 *  parts as the heading level, and only in a document with at least two
 *  such headings, so a lone "3D printing" stays as it is. */
function separateHeadingNumbers(body: HElement): void {
  const glued: Array<{ heading: HElement; at: number }> = []
  for (const h of findAll(body, (e) => HEADING.test(e.tagName))) {
    const m = /^(\s*)(\d+(?:\.\d+)*)\.?(?=\p{L})/u.exec(textOf(h))
    if (m && m[2].split('.').length === headingLevel(h)) glued.push({ heading: h, at: m[0].length })
  }
  if (glued.length < 2) return
  for (const g of glued) insertText(g.heading, g.at, ' ')
}

/** Links to a bookmark inside a heading (Word's `_Toc…` and `_Ref…`
 *  bookmarks) point at that heading through a token the page conversion
 *  turns into the heading's anchor; links to any other bookmark keep only
 *  their text. */
function linkHeadings(body: HElement): void {
  const target = new Map<string, number>()
  let n = 0
  for (const h of findAll(body, (e) => HEADING.test(e.tagName))) {
    n++
    for (const a of findAll(h, (e) => e.tagName === 'a')) {
      const name = prop(a, 'name') || prop(a, 'id')
      if (name) target.set(name, n)
    }
    h.children.push(txt(headingToken(n)))
  }
  unwrapWhere(body, (e) => {
    if (e.tagName !== 'a') return false
    const href = prop(e, 'href')
    if (!href.startsWith('#')) return false
    let name = href.slice(1)
    try {
      name = decodeURIComponent(name)
    } catch {
      // keep it as written
    }
    const id = target.get(name)
    if (id === undefined) return true
    e.properties.href = `${HEADING_LINK}${id}`
    return false
  })
}

/** The body's blocks with wrapping `div`s (sections, header, footer) unwrapped. */
function topLevel(nodes: HNode[]): HNode[] {
  return nodes.flatMap((n) => (isElement(n, 'div') ? topLevel(n.children) : [n]))
}

export function textPrepass(body: HElement, ctx: PrepassContext): OfficeDoc {
  removeWhere(body, (n) => isElement(n, 'div') && TOC_SECTION.test(prop(n, 'id')))
  bump(ctx.dropped, 'pageHeaderFooter', removeWhere(body, (n) => isElement(n, 'div') && PAGE_FURNITURE.test(prop(n, 'title'))))
  bump(
    ctx.dropped,
    'shape',
    removeWhere(body, (n) => isElement(n, 'img') && SHAPE_IMAGE.test(prop(n, 'name')) && /\.gif$/i.test(prop(n, 'src'))),
  )
  stripControls(body)
  // Writer writes comments (annotations) as HTML comments.
  bump(ctx.dropped, 'comment', removeWhere(body, (n) => n.type === 'comment'))
  // Tracked changes: deletions go, insertions stay as plain text.
  bump(ctx.dropped, 'trackedChange', removeWhere(body, (n) => isElement(n, 'del')))
  bump(ctx.dropped, 'trackedChange', unwrapWhere(body, (e) => e.tagName === 'ins'))

  convertNotes(body, ctx)
  const title = applyMarks(body)
  unwrapHeadingLists(body)
  separateHeadingNumbers(body)
  linkHeadings(body)
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
  if (ctx.shiftHeadings) {
    for (const h of findAll(body, (e) => HEADING.test(e.tagName))) h.tagName = `h${headingLevel(h) + 1}`
  }
  flattenDeepHeadings(body, ctx.dropped)
  return {
    ...(title ? { title } : {}),
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
