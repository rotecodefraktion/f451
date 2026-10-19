// Pre-pass on LibreOffice's Writer HTML (spec 2026-10-16-office-import §3
// "Text documents"): footnotes and endnotes, comments and tracked changes,
// heading numbering lists, nested lists, and the cut at the split level
// (spec 2026-10-18-word-import-options §Heading levels, §Split level).

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
  /** Word level at which the document is cut into parts (1–3); null keeps it
   *  one page. One page: every heading one level down (the page title is the
   *  only H1). Split at L: level k becomes k − L + 1, the part heading itself
   *  becomes the page title. */
  splitLevel: number | null
  /** Keep the outline numbers of the headings; default true. */
  numbering?: boolean
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

/** Deletes the first `count` characters of `node`'s text. */
function removeText(node: HNode, count: number): void {
  let left = count
  const visit = (n: HNode): void => {
    if (left <= 0) return
    if (n.type === 'text') {
      const v = n.value ?? ''
      const k = Math.min(left, v.length)
      n.value = v.slice(k)
      left -= k
      return
    }
    for (const c of n.children ?? []) visit(c)
  }
  visit(node)
}

/** A leading outline number, glued to the text (empty group 3) or followed by space. */
const OUTLINE_NUMBER = /^(\s*)(\d+(?:\.\d+)*)\.?(\s+|(?=\p{L}))/u
/** The number at the start of a collapsed heading text. */
const LEADING_NUMBER = /^\d+(?:\.\d+)*\.?\s*/

interface OutlineNumber {
  number: string
  /** Characters from the start of the heading text to the end of the number and its space. */
  length: number
}

/** Word's outline numbers reach the HTML glued to the heading text
 *  ("3.1General"). A number counts as outline number when it has as many
 *  parts as the heading level, and only in a document with at least two
 *  such headings, so a lone "3D printing" stays as it is. Glued numbers get
 *  their space (at least two glued ones, as before); the numbers found are
 *  returned per heading. */
function separateHeadingNumbers(body: HElement): Map<HElement, OutlineNumber> {
  const glued: Array<{ heading: HElement; m: RegExpExecArray }> = []
  const spaced: Array<{ heading: HElement; m: RegExpExecArray }> = []
  for (const h of findAll(body, (e) => HEADING.test(e.tagName))) {
    const m = OUTLINE_NUMBER.exec(textOf(h))
    if (!m || m[2].split('.').length !== headingLevel(h)) continue
    ;(m[3] ? spaced : glued).push({ heading: h, m })
  }
  const found = new Map<HElement, OutlineNumber>()
  if (glued.length >= 2) {
    for (const g of glued) {
      insertText(g.heading, g.m[0].length, ' ')
      found.set(g.heading, { number: g.m[2], length: g.m[0].length + 1 })
    }
  }
  for (const s of spaced) found.set(s.heading, { number: s.m[2], length: s.m[0].length })
  return found.size >= 2 ? found : new Map()
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
  const numbers = separateHeadingNumbers(body)
  const numbering = ctx.numbering ?? true
  if (!numbering) for (const [h, n] of numbers) removeText(h, n.length)
  linkHeadings(body)
  normaliseLists(body, false)
  for (const table of findAll(body, (e) => e.tagName === 'table')) promoteHeader(table)

  // Cut at the Word headings of level ≤ L: a heading of a level above L
  // starts an intermediate part holding its text up to the next cut.
  const cutAt = ctx.splitLevel ?? 0
  const blocks = topLevel(body.children)
  const intro: HNode[] = []
  const roots: Cut[] = []
  const open: Cut[] = []
  for (const n of blocks) {
    const level = isElement(n) && HEADING.test(n.tagName) ? headingLevel(n) : 0
    if (level >= 1 && level <= cutAt) {
      while (open.length && open[open.length - 1].level >= level) open.pop()
      const cut: Cut = { heading: n as HElement, level, nodes: [], children: [] }
      ;(open.length ? open[open.length - 1].children : roots).push(cut)
      open.push(cut)
    } else if (open.length) open[open.length - 1].nodes.push(n)
    else intro.push(n)
  }

  const shift = ctx.splitLevel === null ? 1 : 1 - ctx.splitLevel
  if (shift !== 0) {
    for (const h of findAll(body, (e) => HEADING.test(e.tagName))) h.tagName = `h${Math.max(1, headingLevel(h) + shift)}`
  }
  flattenDeepHeadings(body, ctx.dropped)

  const toPart = (c: Cut, position: string): OfficePart => {
    const shown = collapse(stripTokens(textOf(c.heading)))
    const number = numbers.get(c.heading)?.number ?? null
    const title = shown || `${label('chapter', ctx.lang)} ${position}`
    return {
      title,
      heading: serialize([c.heading]),
      html: serialize(c.nodes),
      level: c.level,
      number,
      text: number !== null && numbering ? collapse(title.replace(LEADING_NUMBER, '')) || title : title,
      children: c.children.map((k, i) => toPart(k, `${position}.${i + 1}`)),
    }
  }
  return {
    ...(title ? { title } : {}),
    intro: serialize(intro),
    parts: roots.map((c, i) => toPart(c, String(i + 1))),
  }
}

interface Cut {
  heading: HElement
  /** Word level of the heading. */
  level: number
  nodes: HNode[]
  children: Cut[]
}
