// Tracked changes are accepted before LibreOffice sees the file. LibreOffice's
// HTML export writes deleted text as ordinary text (no <del>), so a document
// with open revisions would come out with old and new wording side by side.
// Accepting them here gives the text Word shows in its "final" view.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** Element names (with prefix) whose whole content is dropped. */
const OOXML_DROP = [
  'w:del',
  'w:moveFrom',
  'w:rPrChange',
  'w:pPrChange',
  'w:sectPrChange',
  'w:tblPrChange',
  'w:tblPrExChange',
  'w:trPrChange',
  'w:tcPrChange',
  'w:tblGridChange',
  'w:numberingChange',
  'w:cellDel',
]
/** Element names whose tags go and whose content stays. */
const OOXML_UNWRAP = ['w:ins', 'w:moveTo']
/** Empty marker elements that only bound a revision. */
const OOXML_MARKERS = [
  'w:moveFromRangeStart',
  'w:moveFromRangeEnd',
  'w:moveToRangeStart',
  'w:moveToRangeEnd',
  'w:cellIns',
  'w:cellMerge',
]

const OOXML_PARTS = /^word\/(document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/

interface Span {
  start: number
  /** Index after the start tag. */
  open: number
  /** Index of the end tag (equals `end` for an empty element). */
  close: number
  end: number
  selfClosing: boolean
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The element `name` starting at `start` (which points at its `<`), with
 *  nested elements of the same name counted. */
function spanAt(xml: string, name: string, start: number): Span | null {
  const tagEnd = xml.indexOf('>', start)
  if (tagEnd < 0) return null
  if (xml[tagEnd - 1] === '/') return { start, open: tagEnd + 1, close: tagEnd + 1, end: tagEnd + 1, selfClosing: true }
  const re = new RegExp(`<(/?)${escapeRe(name)}(?=[\\s/>])[^>]*?(/?)>`, 'g')
  re.lastIndex = tagEnd + 1
  let depth = 1
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1]) depth--
    else if (!m[2]) depth++
    if (depth === 0) return { start, open: tagEnd + 1, close: m.index, end: m.index + m[0].length, selfClosing: false }
  }
  return null
}

/** Every outermost element `name` in `xml`, in order. */
function spans(xml: string, name: string, from = 0, to = xml.length): Span[] {
  const re = new RegExp(`<${escapeRe(name)}(?=[\\s/>])`, 'g')
  re.lastIndex = from
  const out: Span[] = []
  for (let m = re.exec(xml); m && m.index < to; m = re.exec(xml)) {
    const s = spanAt(xml, name, m.index)
    if (!s) break
    out.push(s)
    re.lastIndex = s.end
  }
  return out
}

/** Rebuilds `xml` with each span replaced by `fn(span)`. */
function replaceSpans(xml: string, list: Span[], fn: (s: Span) => string): string {
  let out = ''
  let at = 0
  for (const s of list) {
    out += xml.slice(at, s.start) + fn(s)
    at = s.end
  }
  return out + xml.slice(at)
}

/** The direct `<w:pPr>` of a paragraph span, or null. */
function paragraphProps(xml: string, p: Span): Span | null {
  const head = xml.slice(p.open, p.close).match(/^\s*<w:pPr(?=[\s/>])/)
  return head ? spanAt(xml, 'w:pPr', p.open + head[0].indexOf('<')) : null
}

/** The paragraph mark itself is a deleted revision: Word joins the
 *  paragraph with the next one when the change is accepted. */
function markDeleted(xml: string, p: Span): boolean {
  const pPr = paragraphProps(xml, p)
  if (!pPr || pPr.selfClosing) return false
  const rPr = spans(xml, 'w:rPr', pPr.open, pPr.close)[0]
  return !!rPr && !rPr.selfClosing && /<w:del(?=[\s/>])/.test(xml.slice(rPr.open, rPr.close))
}

/** Runs and other content of a paragraph, without its properties. */
function paragraphContent(xml: string, p: Span): string {
  const pPr = paragraphProps(xml, p)
  return xml.slice(pPr ? pPr.end : p.open, p.close)
}

/** Joins each paragraph whose mark was deleted with the paragraph that
 *  follows it directly; the joined paragraph keeps the later one's
 *  properties, as in Word. */
function joinDeletedMarks(xml: string): { xml: string; joined: number } {
  const paragraphs = spans(xml, 'w:p')
  let joined = 0
  let out = ''
  let at = 0
  // Content of earlier paragraphs waiting to be joined into the next one.
  let carry = ''
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const next = paragraphs[i + 1]
    const joinable =
      !!next &&
      !p.selfClosing &&
      !next.selfClosing &&
      xml.slice(p.end, next.start).trim() === '' &&
      markDeleted(xml, p)
    out += xml.slice(at, p.start)
    if (joinable) {
      carry += paragraphContent(xml, p)
      joined++
      at = next.start
      continue
    }
    if (carry && !p.selfClosing) {
      const pPr = paragraphProps(xml, p)
      const split = pPr ? pPr.end : p.open
      out += xml.slice(p.start, split) + carry + xml.slice(split, p.end)
    } else out += xml.slice(p.start, p.end)
    carry = ''
    at = p.end
  }
  return { xml: out + xml.slice(at), joined }
}

/** Accepts every tracked change in one WordprocessingML part. */
export function acceptOoxmlPart(input: string): { xml: string; changes: number } {
  let xml = input
  let changes = 0

  // Deleted table rows.
  const rows = spans(xml, 'w:tr').filter((tr) => {
    const firstCell = xml.slice(tr.open, tr.close).search(/<w:tc(?=[\s/>])/)
    const head = xml.slice(tr.open, firstCell < 0 ? tr.close : tr.open + firstCell)
    return /<w:trPr(?=[\s>])[\s\S]*<w:del(?=[\s/>])/.test(head)
  })
  changes += rows.length
  xml = replaceSpans(xml, rows, () => '')

  // Deleted and moved-away content, and the old formatting of changed properties.
  for (const name of OOXML_DROP) {
    const list = spans(xml, name).filter((s) => !s.selfClosing || name !== 'w:del')
    changes += list.length
    xml = replaceSpans(xml, list, () => '')
  }

  const merged = joinDeletedMarks(xml)
  xml = merged.xml
  changes += merged.joined

  // What is left of the markers: deleted or inserted paragraph marks, range bounds.
  for (const name of ['w:del', 'w:ins', ...OOXML_MARKERS]) {
    const list = spans(xml, name).filter((s) => s.selfClosing)
    changes += list.length
    xml = replaceSpans(xml, list, () => '')
  }
  for (const name of OOXML_UNWRAP) {
    const list = spans(xml, name)
    changes += list.length
    xml = replaceSpans(xml, list, (s) => (s.selfClosing ? '' : xml.slice(s.open, s.close)))
  }
  return { xml, changes }
}

/** Accepts every tracked change in an ODF `content.xml`: the deleted text
 *  lives only in `text:tracked-changes`, the body already reads as accepted
 *  once the change marks are gone. */
export function acceptOdfContent(input: string): { xml: string; changes: number } {
  let xml = input
  let changes = 0
  for (const name of ['text:tracked-changes']) {
    const list = spans(xml, name)
    xml = replaceSpans(xml, list, () => '')
  }
  for (const name of ['text:change', 'text:change-start', 'text:change-end']) {
    const list = spans(xml, name)
    if (name !== 'text:change-end') changes += list.length
    xml = replaceSpans(xml, list, () => '')
  }
  return { xml, changes }
}

/** The package with all tracked changes accepted, and how many there were.
 *  Returns the input unchanged when it is not a Word or ODF text package or
 *  has no revisions. */
export function acceptTrackedChanges(bytes: Uint8Array, ext: string): { bytes: Uint8Array; changes: number } {
  const ooxml = ext === 'docx' || ext === 'docm' || ext === 'dotx' || ext === 'dotm'
  if (!ooxml && ext !== 'odt' && ext !== 'ott') return { bytes, changes: 0 }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    return { bytes, changes: 0 }
  }
  let changes = 0
  for (const [path, data] of Object.entries(files)) {
    const part = ooxml ? OOXML_PARTS.test(path) : path === 'content.xml'
    if (!part) continue
    const before = strFromU8(data)
    const after = ooxml ? acceptOoxmlPart(before) : acceptOdfContent(before)
    if (after.changes === 0) continue
    changes += after.changes
    files[path] = strToU8(after.xml)
  }
  if (changes === 0) return { bytes, changes: 0 }
  // `mimetype` stays first and stored, as ODF requires.
  const ordered: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}
  if (files.mimetype) ordered.mimetype = [files.mimetype, { level: 0 }]
  for (const [path, data] of Object.entries(files)) if (path !== 'mimetype') ordered[path] = data
  return { bytes: zipSync(ordered), changes }
}
