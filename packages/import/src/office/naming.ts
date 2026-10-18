// Page names of a Word import (spec 2026-10-18-word-import-options §Main page
// name, §Subpage name): the main page by title, file name or an own ID with a
// counter drawn from the target space, subpages by chapter and key.

/** Options for text documents (docx, odt, doc, rtf and templates). */
export interface WordOptions {
  /** Keep the outline numbers of the headings. */
  numbering: boolean
  mainName: 'title' | 'file' | 'id'
  /** Required when `mainName` is `id`; a run of `#` is the counter. */
  idPattern?: string
  idDisplay: 'id' | 'id-title'
  subName: 'chapter' | 'title-chapter' | 'key-chapter' | 'key-number'
  splitLevel: 1 | 2 | 3
  toc: boolean
  tocDepth: 1 | 2 | 3
}

export const DEFAULT_WORD_OPTIONS: WordOptions = {
  numbering: true,
  mainName: 'title',
  idDisplay: 'id-title',
  subName: 'chapter',
  splitLevel: 1,
  toc: true,
  tocDepth: 2,
}

export interface IdPattern {
  prefix: string
  /** Minimum number of digits (`###` → 001). */
  width: number
  suffix: string
}

const COUNTER = /^([^#]*)(#+)([^#]*)$/
/** Separator of key and chapter. */
const DASH = ' – '

/** The counter of `pattern`; null for a pattern without one `#` run (a fixed
 *  ID). The API rejects patterns with more than one run. */
export function parseIdPattern(pattern: string): IdPattern | null {
  const m = COUNTER.exec(pattern)
  return m ? { prefix: m[1], width: m[2].length, suffix: m[3] } : null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The counter value in `title`, matched at its start; null if it does not
 *  follow the pattern. */
function numberIn(p: IdPattern, title: string): number | null {
  const m = new RegExp(`^${escapeRegExp(p.prefix)}(\\d+)${escapeRegExp(p.suffix)}`).exec(title)
  return m ? Number(m[1]) : null
}

/** Highest counter found in `titles` + 1, starting at 1. */
export function nextIdNumber(pattern: string, titles: string[]): number {
  const p = parseIdPattern(pattern)
  if (!p) return 1
  let max = 0
  for (const t of titles) {
    const n = numberIn(p, t)
    if (n !== null && n > max) max = n
  }
  return max + 1
}

/** The ID for counter value `n`; a pattern without counter is the ID itself. */
export function formatId(pattern: string, n: number): string {
  const p = parseIdPattern(pattern)
  return p ? `${p.prefix}${String(n).padStart(p.width, '0')}${p.suffix}` : pattern
}

/** IDs for the files of one run (`sourceIds` in source-path order). A file
 *  whose source id is in `existingIds` and whose current title follows the
 *  pattern keeps its number; the others draw consecutive numbers after the
 *  highest one in the space. */
export function assignIds(
  pattern: string,
  sourceIds: string[],
  existingTitles: string[],
  existingIds: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  const p = parseIdPattern(pattern)
  if (!p) {
    for (const id of sourceIds) out.set(id, pattern)
    return out
  }
  let next = nextIdNumber(pattern, existingTitles)
  for (const id of sourceIds) {
    const current = existingIds.get(id)
    const n = current === undefined ? null : numberIn(p, current)
    if (n === null) continue
    out.set(id, formatId(pattern, n))
    if (n >= next) next = n + 1
  }
  for (const id of sourceIds) if (!out.has(id)) out.set(id, formatId(pattern, next++))
  return out
}

/** Name of the main page. Without an ID (no pattern given) the title stays. */
export function mainTitle(o: {
  mainName: WordOptions['mainName']
  idDisplay: WordOptions['idDisplay']
  title: string
  fileName: string
  id?: string
}): string {
  if (o.mainName === 'file') return o.fileName
  if (o.mainName === 'id' && o.id) return o.idDisplay === 'id' ? o.id : `${o.id} ${o.title}`
  return o.title
}

/** Name of a subpage. `chapter` is the heading as shown (with its number when
 *  numbering is on), `text` the heading without number, `number` the outline
 *  number (also when numbering is off), `position` the dotted position used
 *  when the heading has no number. `key` is the file name or the ID. */
export function subTitle(o: {
  subName: WordOptions['subName']
  chapter: string
  text: string
  number: string | null
  position: string
  docTitle: string
  key: string
}): string {
  switch (o.subName) {
    case 'title-chapter':
      return `${o.docTitle}${DASH}${o.chapter}`
    case 'key-chapter':
      return `${o.key}${DASH}${o.chapter}`
    case 'key-number':
      return `${o.key}.${o.number ?? o.position} ${o.text}`.trimEnd()
    default:
      return o.chapter
  }
}
