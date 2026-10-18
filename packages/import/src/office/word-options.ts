import { originOf } from '../frontmatter.js'
import type { ExistingScan } from '../model.js'
import { parseIdPattern, type WordOptions } from './naming.js'

// Text options of a Word import as they arrive from the API form and the CLI
// (spec 2026-10-18-word-import-options §Options): strings, validated once here
// so both entry points answer with the same messages.

export const WORD_OPTION_FIELDS = [
  'numbering',
  'mainName',
  'idPattern',
  'idDisplay',
  'subName',
  'splitLevel',
  'toc',
  'tocDepth',
] as const

export type WordOptionField = (typeof WORD_OPTION_FIELDS)[number]
export type WordOptionFields = Partial<Record<WordOptionField, string | undefined>>

/** Fields that only make sense when the text is split into subpages. */
const SPLIT_ONLY: WordOptionField[] = ['subName', 'splitLevel', 'toc', 'tocDepth']

const MAIN_NAMES = ['title', 'file', 'id']
const ID_DISPLAYS = ['id', 'id-title']
const SUB_NAMES = ['chapter', 'title-chapter', 'key-chapter', 'key-number']
const ID_PATTERN_CHARS = /^[A-Za-z0-9\-_. #]{1,40}$/

function flag(v: string): boolean | null {
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return null
}

function level(v: string): 1 | 2 | 3 | null {
  return v === '1' || v === '2' || v === '3' ? (Number(v) as 1 | 2 | 3) : null
}

/** True if any Word option is set (empty strings count as unset). */
export function hasWordOptions(fields: WordOptionFields): boolean {
  return WORD_OPTION_FIELDS.some((f) => fields[f] !== undefined && fields[f] !== '')
}

/** Validates the Word options. Returns only the options that were given, so the
 *  adapter's defaults apply to the rest. */
export function parseWordOptions(
  fields: WordOptionFields,
  split: boolean,
): { ok: true; text: Partial<WordOptions> } | { ok: false; error: string } {
  const f: WordOptionFields = {}
  for (const k of WORD_OPTION_FIELDS) if (fields[k] !== undefined && fields[k] !== '') f[k] = fields[k]
  const fail = (error: string) => ({ ok: false as const, error })
  const text: Partial<WordOptions> = {}

  if (!split) {
    const stray = SPLIT_ONLY.find((k) => f[k] !== undefined)
    if (stray) return fail(`${stray} needs split.`)
  }

  if (f.numbering !== undefined) {
    const v = flag(f.numbering)
    if (v === null) return fail('numbering must be "true" or "false".')
    text.numbering = v
  }
  if (f.mainName !== undefined) {
    if (!MAIN_NAMES.includes(f.mainName)) return fail('mainName must be "title", "file" or "id".')
    text.mainName = f.mainName as WordOptions['mainName']
  }
  if (f.idPattern !== undefined) {
    const p = f.idPattern
    if (!ID_PATTERN_CHARS.test(p)) {
      return fail('idPattern must be 1-40 characters: letters, digits, "-", "_", ".", space and "#".')
    }
    // One contiguous run of "#" (the counter); none makes a fixed ID.
    if ((p.match(/#+/g) ?? []).length > 1 || (p.includes('#') && !parseIdPattern(p))) {
      return fail('idPattern may contain only one run of "#" (the counter).')
    }
    text.idPattern = p
  }
  if (text.mainName === 'id' && text.idPattern === undefined) return fail('mainName "id" needs an idPattern.')
  if (f.idDisplay !== undefined) {
    if (!ID_DISPLAYS.includes(f.idDisplay)) return fail('idDisplay must be "id" or "id-title".')
    text.idDisplay = f.idDisplay as WordOptions['idDisplay']
  }
  if (f.subName !== undefined) {
    if (!SUB_NAMES.includes(f.subName)) {
      return fail('subName must be "chapter", "title-chapter", "key-chapter" or "key-number".')
    }
    text.subName = f.subName as WordOptions['subName']
  }
  if (f.splitLevel !== undefined) {
    const v = level(f.splitLevel)
    if (v === null) return fail('splitLevel must be 1, 2 or 3.')
    text.splitLevel = v
  }
  if (f.toc !== undefined) {
    const v = flag(f.toc)
    if (v === null) return fail('toc must be "true" or "false".')
    text.toc = v
  }
  if (f.tocDepth !== undefined) {
    const v = level(f.tocDepth)
    if (v === null) return fail('tocDepth must be 1, 2 or 3.')
    text.tocDepth = v
  }
  return { ok: true, text }
}

/** What the ID counter of a Word import needs from the target space (a
 *  `scanExisting` of it): all page titles, and for pages in the target subtree
 *  that came from an Office import of the same `origin`, source id → current
 *  title. Without `origin`, any Office page in the subtree counts. */
export function collectExistingNames(
  scan: ExistingScan,
  origin?: string,
): { existingTitles: string[]; existingIds: Map<string, string> } {
  const existingTitles: string[] = []
  const existingIds = new Map<string, string>()
  for (const p of scan.pages) {
    existingTitles.push(p.title)
    if (!p.inSubtree) continue
    const source = scan.sources.get(p.id)
    if (!source || source.type !== 'office' || existingIds.has(source.id)) continue
    if (origin && originOf(source) !== origin) continue
    existingIds.set(source.id, p.title)
  }
  return { existingTitles, existingIds }
}
