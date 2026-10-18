// LibreOffice's HTML export drops paragraph styles: the Title paragraph comes
// out as a plain <p> with font markup, and Word heading levels 7–9 as plain
// <p> too (probe 2026-10-18, LibreOffice 25.2). Before the conversion, this
// pass puts a token into those paragraphs of the source package; the text
// pre-pass turns the marked paragraphs into the title and into h7–h9.

import { strFromU8, strToU8 } from 'fflate'
import { escapeRe, paragraphProps, spanAt, spans, type PackageKind } from './revisions.js'
import { levelToken, TITLE_TOKEN } from './tokens.js'

/** First outline level (1-based) that LibreOffice no longer writes as a heading. */
const DEEP = 7

interface WordStyle {
  name: string
  basedOn: string | null
  /** `w:outlineLvl` (0-based; 9 means body text), null if not set. */
  outline: number | null
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${escapeRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return m ? (m[1] ?? m[2]) : null
}

/** `w:val` of the first element `name` in `xml`, or null. */
function childVal(xml: string, name: string): string | null {
  const m = new RegExp(`<${escapeRe(name)}(?=[\\s/>])[^>]*>`).exec(xml)
  return m ? attrOf(m[0], 'w:val') : null
}

function toLevel(v: string | null): number | null {
  if (v === null || !/^\d+$/.test(v.trim())) return null
  return Number(v)
}

/** Paragraph styles of `word/styles.xml` by `w:styleId`, and the default one. */
function wordStyles(xml: string): { styles: Map<string, WordStyle>; defaultId: string | null } {
  const styles = new Map<string, WordStyle>()
  let defaultId: string | null = null
  for (const s of spans(xml, 'w:style')) {
    const tag = xml.slice(s.start, s.open)
    if ((attrOf(tag, 'w:type') ?? 'paragraph') !== 'paragraph') continue
    const id = attrOf(tag, 'w:styleId')
    if (!id) continue
    const inner = s.selfClosing ? '' : xml.slice(s.open, s.close)
    styles.set(id, {
      name: childVal(inner, 'w:name') ?? '',
      basedOn: childVal(inner, 'w:basedOn'),
      outline: toLevel(childVal(inner, 'w:outlineLvl')),
    })
    if (/^(1|true|on)$/.test(attrOf(tag, 'w:default') ?? '')) defaultId = id
  }
  return { styles, defaultId }
}

/** 0-based outline level of a style: its own `w:outlineLvl`, else its name
 *  (`heading n`), else that of the style it is based on. */
function styleOutline(id: string | null, styles: Map<string, WordStyle>, seen = new Set<string>()): number | null {
  if (id === null || seen.has(id)) return null
  const s = styles.get(id)
  if (!s) return null
  seen.add(id)
  if (s.outline !== null) return s.outline
  const named = /^heading ([1-9])$/i.exec(s.name.trim())
  if (named) return Number(named[1]) - 1
  return styleOutline(s.basedOn, styles, seen)
}

function insertAll(xml: string, inserts: Array<{ at: number; text: string }>): string {
  let out = ''
  let at = 0
  for (const i of [...inserts].sort((a, b) => a.at - b.at)) {
    out += xml.slice(at, i.at) + i.text
    at = i.at
  }
  return out + xml.slice(at)
}

function run(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`
}

/** Marks the first paragraph in the style named `Title` and every paragraph
 *  with outline level 7 or deeper (own `w:outlineLvl` or through its style)
 *  in a `word/document.xml`. Paragraphs without text are left alone. */
export function markOoxml(documentXml: string, stylesXml: string | null): { xml: string; marked: number } {
  const { styles, defaultId } = stylesXml ? wordStyles(stylesXml) : { styles: new Map<string, WordStyle>(), defaultId: null }
  const xml = documentXml
  const inserts: Array<{ at: number; text: string }> = []
  let titleDone = false
  for (const p of spans(xml, 'w:p')) {
    if (p.selfClosing) continue
    const pPr = paragraphProps(xml, p)
    const props = pPr && !pPr.selfClosing ? xml.slice(pPr.open, pPr.close) : ''
    const at = pPr ? pPr.end : p.open
    if (!/<w:t(?=[\s>])/.test(xml.slice(at, p.close))) continue
    const styleId = childVal(props, 'w:pStyle') ?? defaultId
    if (!titleDone && styleId !== null && styles.get(styleId)?.name.trim().toLowerCase() === 'title') {
      titleDone = true
      inserts.push({ at, text: run(TITLE_TOKEN) })
      continue
    }
    const outline = toLevel(childVal(props, 'w:outlineLvl')) ?? styleOutline(styleId, styles)
    // 9 is "body text"; 6–8 are levels 7–9.
    if (outline !== null && outline + 1 >= DEEP && outline <= 8) inserts.push({ at, text: run(levelToken(outline + 1)) })
  }
  return { xml: inserts.length ? insertAll(xml, inserts) : xml, marked: inserts.length }
}

/** Marks the first `text:p`/`text:h` in the style `Title` (or an automatic
 *  style derived from it) and every `text:h` with outline level 7 or deeper
 *  in an ODF `content.xml`. Paragraphs without text are left alone. */
export function markOdf(contentXml: string): { xml: string; marked: number } {
  const xml = contentXml
  const titleStyles = new Set(['Title'])
  for (const s of spans(xml, 'style:style')) {
    const tag = xml.slice(s.start, s.open)
    const name = attrOf(tag, 'style:name')
    if (name && attrOf(tag, 'style:parent-style-name') === 'Title') titleStyles.add(name)
  }
  const inserts: Array<{ at: number; text: string }> = []
  let titleDone = false
  const re = /<text:(p|h)(?=[\s/>])[^>]*>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const tag = m[0]
    if (tag.endsWith('/>')) continue
    const span = spanAt(xml, `text:${m[1]}`, m.index)
    if (!span || xml.slice(span.open, span.close).replace(/<[^>]*>/g, '').trim() === '') continue
    const at = m.index + tag.length
    const style = attrOf(tag, 'text:style-name')
    if (!titleDone && style !== null && titleStyles.has(style)) {
      titleDone = true
      inserts.push({ at, text: TITLE_TOKEN })
      continue
    }
    const level = m[1] === 'h' ? toLevel(attrOf(tag, 'text:outline-level')) : null
    if (level !== null && level >= DEEP) inserts.push({ at, text: levelToken(level) })
  }
  return { xml: inserts.length ? insertAll(xml, inserts) : xml, marked: inserts.length }
}

/** Marks the unzipped package `files` in place; returns how many paragraphs. */
export function markPackage(files: Record<string, Uint8Array>, kind: PackageKind): number {
  const path = kind === 'ooxml' ? 'word/document.xml' : 'content.xml'
  const part = files[path]
  if (!part) return 0
  const styles = kind === 'ooxml' && files['word/styles.xml'] ? strFromU8(files['word/styles.xml']) : null
  const out = kind === 'ooxml' ? markOoxml(strFromU8(part), styles) : markOdf(strFromU8(part))
  if (out.marked) files[path] = strToU8(out.xml)
  return out.marked
}
