// Pre-pass on LibreOffice's Impress XHTML (spec 2026-10-16-office-import §3
// "Presentations"). Each slide is a `div` of absolutely positioned frame divs;
// the ODF copy says which frame is the title, the outline, the notes or a
// placeholder (`presentation:class`), matched by frame name, else by position
// among the unnamed frames. Without a match the frame id is used.

import { htmlToMarkdown } from '../adapters/bookstack/html-to-md.js'
import { chartTables, isChartImage } from './charts.js'
import { label, type Lang, type OfficeDoc, type OfficePart } from './doc.js'
import {
  classList,
  collapse,
  el,
  findAll,
  isBlank,
  isElement,
  prop,
  promoteHeader,
  removeWhere,
  serialize,
  textOf,
  txt,
  type HElement,
  type HNode,
} from './hast.js'
import { normaliseLists } from './lists.js'
import type { OdfFrame, OdfPage } from './odf.js'
import type { Tokens } from './tokens.js'

export interface SlidesContext {
  tokens: Tokens
  dropped: Record<string, number>
  lang: Lang
  split: boolean
  /** Slides of the ODF copy, in order. */
  pages: OdfPage[]
  /** Attachment list Markdown per slide index (0-based), placed at the end of the slide. */
  attachments: (headingDepth: number, slide: number) => string | null
}

type Role = 'title' | 'notes' | 'drop' | 'body'

const DROP_CLASSES = new Set(['page-number', 'date-time', 'footer', 'header', 'handout', 'page'])
const FIELD_TITLES = /^(page-number|page-count|date|time|date-time|footer|header)$/

const ID_ROLES: Array<[RegExp, Role]> = [
  [/^(sub_?title|untertitel)/i, 'body'],
  [/^(title|titel)/i, 'title'],
  [/notes?_?placeholder|notizen|^notes/i, 'notes'],
  [/slide_?number|folien_?nummer|page_?number/i, 'drop'],
  [/^(date|datum)/i, 'drop'],
  [/footer|fu(ß|ss)zeile/i, 'drop'],
]

function roleOfClass(f: OdfFrame): Role {
  // On the notes page only the notes text counts (not its slide number, header, …).
  if (f.inNotes) return f.cls === 'notes' || f.cls === '' || f.cls === 'outline' ? 'notes' : 'drop'
  if (f.cls === 'notes') return 'notes'
  if (f.cls === 'title') return 'title'
  if (DROP_CLASSES.has(f.cls)) return 'drop'
  return 'body'
}

function roleOfId(id: string): Role {
  for (const [re, role] of ID_ROLES) if (re.test(id)) return role
  return 'body'
}

function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Assigns each frame div a role from the matching ODF frame. */
function roles(frames: HElement[], page: OdfPage | undefined): Role[] {
  const odf = page?.frames ?? []
  const byName = new Map<string, number[]>()
  const unnamed: number[] = []
  for (const [i, f] of odf.entries()) {
    if (f.name) byName.set(nameKey(f.name), [...(byName.get(nameKey(f.name)) ?? []), i])
    else unnamed.push(i)
  }
  const used = new Set<number>()
  let nextUnnamed = 0
  return frames.map((frame) => {
    const id = prop(frame, 'id')
    let hit: number | undefined
    if (id) hit = byName.get(nameKey(id))?.find((i) => !used.has(i))
    else if (page) hit = unnamed[nextUnnamed++]
    if (hit !== undefined) {
      used.add(hit)
      return roleOfClass(odf[hit])
    }
    return id ? roleOfId(id) : 'body'
  })
}

/** Removes LibreOffice's bullet characters (a floating span at the start of
 *  each item); a number-like bullet marks the item as numbered. */
function stripBullets(frame: HElement): void {
  for (const li of findAll(frame, (e) => e.tagName === 'li')) {
    removeWhere(li, (n) => {
      if (!isElement(n, 'span')) return false
      if (classList(n).includes('odfLiEnd')) return true
      const style = prop(n, 'style').replace(/\s+/g, '')
      if (!/display:block/.test(style) || !/float:left/.test(style)) return false
      if (/^\(?(\d+|[a-z]|[ivx]+)[.)]$/i.test(collapse(textOf(n)))) li.properties.dataF451Numbered = true
      return true
    })
  }
}

/** The frame's block content: wrapper `div`s unwrapped, blanks dropped. */
function blocksOf(nodes: HNode[]): HNode[] {
  const out: HNode[] = []
  for (const n of nodes) {
    if (isElement(n, 'div')) out.push(...blocksOf(n.children))
    else if (!isBlank(n)) out.push(n)
  }
  return out
}

function hasText(table: HElement): boolean {
  const cells = findAll(table, (e) => e.tagName === 'td' || e.tagName === 'th')
  return cells.length >= 2 && cells.some((c) => textOf(c).trim() !== '')
}

function frameBlocks(frame: HElement): HNode[] {
  const charts = findAll(frame, isChartImage)
  if (charts.length) {
    const tables = findAll(frame, (e) => e.tagName === 'table' && hasText(e) && !charts.some((c) => chartTables.get(c) === e))
    // A table with its SVM preview (preview not matched away): the table counts.
    if (tables.length && !charts.some((c) => chartTables.has(c))) {
      for (const t of tables) promoteHeader(t)
      return tables
    }
    // A chart frame: LibreOffice also writes the chart's inner text; only the
    // image and the data table are kept.
    return charts.flatMap((img) => {
      const table = chartTables.get(img)
      return table ? [el('p', {}, [img]), table] : [el('p', {}, [img])]
    })
  }
  stripBullets(frame)
  normaliseLists(frame, true)
  for (const t of findAll(frame, (e) => e.tagName === 'table')) promoteHeader(t)
  return blocksOf(frame.children)
}

function notesBlock(nodes: HNode[], ctx: SlidesContext): string | null {
  const converted = htmlToMarkdown(serialize(nodes), { baseUrl: '', resolveInternalLink: () => null })
  for (const [k, n] of Object.entries(converted.dropped)) ctx.dropped[k] = (ctx.dropped[k] ?? 0) + n
  const md = converted.markdown.trim()
  if (!md) return null
  const quoted = md
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
  return `> [!NOTE]\n> **Speaker notes**\n>\n${quoted}`
}

function paragraph(text: string): HElement {
  const lines = text.split('\n')
  return el('p', {}, lines.flatMap((l, i) => (i ? [el('br'), txt(l)] : [txt(l)])))
}

export function slidesPrepass(body: HElement, ctx: SlidesContext): OfficeDoc {
  // Slide numbers, dates and footers can also sit as fields inside a text frame.
  removeWhere(body, (n) => isElement(n, 'span') && FIELD_TITLES.test(prop(n, 'title')))

  const all = body.children.filter((c): c is HElement => isElement(c, 'div'))
  const marked = all.filter((d) => classList(d).some((c) => c.startsWith('page-')))
  const slides = marked.length ? marked : all
  const pagesMatch = ctx.pages.length === slides.length

  const parts: OfficePart[] = slides.map((slide, index) => {
    const frames = slide.children.filter((c): c is HElement => isElement(c, 'div'))
    const frameRoles = roles(frames, pagesMatch ? ctx.pages[index] : undefined)
    let title = ''
    const blocks: HNode[] = []
    const notes: HNode[] = []
    for (const [i, frame] of frames.entries()) {
      const role = frameRoles[i]
      if (role === 'drop') continue
      if (role === 'title') {
        if (!title) title = collapse(textOf(frame))
        continue
      }
      if (role === 'notes') {
        stripBullets(frame)
        normaliseLists(frame, true)
        notes.push(...blocksOf(frame.children))
        continue
      }
      blocks.push(...frameBlocks(frame))
    }

    // Text of shapes the XHTML export leaves out (custom shapes, SmartArt parts).
    const page = pagesMatch ? ctx.pages[index] : undefined
    if (page?.shapeTexts.length) {
      const shown = collapse([title, ...blocks.map(textOf), ...notes.map(textOf)].join(' '))
      for (const t of page.shapeTexts) if (!shown.includes(collapse(t))) blocks.push(paragraph(t))
    }

    const note = notes.length ? notesBlock(notes, ctx) : null
    if (note) blocks.push(el('p', {}, [txt(ctx.tokens.block(note))]))
    const attachments = ctx.attachments(ctx.split ? 2 : 3, index)
    if (attachments) blocks.push(el('p', {}, [txt(ctx.tokens.block(attachments))]))

    const slideTitle = title || `${label('slide', ctx.lang)} ${index + 1}`
    return {
      title: slideTitle,
      heading: serialize([el('h2', {}, [txt(slideTitle)])]),
      html: serialize(blocks),
    }
  })
  return { intro: '', parts }
}
