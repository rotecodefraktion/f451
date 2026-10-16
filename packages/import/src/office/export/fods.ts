// Excel export: every GFM table of the pages as one sheet of a Flat ODS
// (`document.fods`), which the convert service turns into xlsx (spec §3 Excel).

import { markdownProcessor } from '@f451/markdown'
import type { ExportPageSource } from './load.js'
import { escapeXml, tag } from './xml.js'

interface MNode {
  type: string
  value?: string
  data?: { alias?: string }
  children?: MNode[]
}

export class NoTablesError extends Error {
  constructor() {
    super('no tables to export')
    this.name = 'NoTablesError'
  }
}

const SHEET_NAME_MAX = 31
const SIGNIFICANT_DIGITS = 15

export type CellValue =
  | { type: 'float'; value: number }
  | { type: 'percentage'; value: number; decimals: number }
  | { type: 'date'; value: string }
  | { type: 'string' }

/** One separator: it is the decimal sign. */
const SIMPLE = /^[+-]?\d+(?:([.,])(\d+))?$/
/** Thousands groups with one separator and a different decimal sign after them. */
const GROUPED = /^[+-]?\d{1,3}(?:([.,])\d{3})+([.,])(\d+)$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const PERCENT = /^(.*?)[   ]?%$/

function digitCount(s: string): number {
  return s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').length
}

/** A number written in the cell, or null. Leading zeros (`0049`) and more than
 *  15 significant digits stay text: as a number they would change. */
function parseNumber(s: string): { value: number; decimals: number } | null {
  const unsigned = s.replace(/^[+-]/, '')
  if (/^0\d/.test(unsigned)) return null
  if (digitCount(s) > SIGNIFICANT_DIGITS) return null
  let normalized: string
  let decimals: number
  const simple = SIMPLE.exec(s)
  if (simple) {
    normalized = simple[1] ? s.replace(simple[1], '.') : s
    decimals = simple[2]?.length ?? 0
  } else {
    const grouped = GROUPED.exec(s)
    if (!grouped || grouped[1] === grouped[2]) return null
    const decimal = grouped[2]!
    const at = s.lastIndexOf(decimal)
    normalized = s.slice(0, at).split(grouped[1]!).join('') + '.' + s.slice(at + 1)
    decimals = grouped[3]!.length
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? { value, decimals } : null
}

/** The value rules of spec §3 Excel; everything else is text. */
export function classifyCell(raw: string): CellValue {
  const s = raw.trim()
  if (!s) return { type: 'string' }
  const date = ISO_DATE.exec(s)
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])]
    const check = new Date(Date.UTC(y, m - 1, d))
    const valid = check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d
    return valid ? { type: 'date', value: s } : { type: 'string' }
  }
  const pct = PERCENT.exec(s)
  if (pct) {
    const n = parseNumber(pct[1]!)
    if (!n) return { type: 'string' }
    return { type: 'percentage', value: Number((n.value / 100).toPrecision(SIGNIFICANT_DIGITS)), decimals: n.decimals }
  }
  const n = parseNumber(s)
  return n ? { type: 'float', value: n.value } : { type: 'string' }
}

/** A valid, unique Excel sheet name: `[]:*?/\` removed, at most 31 characters,
 *  no apostrophe at either end, `" (2)"`, `" (3)"` … for repeats (case-insensitive). */
export function sheetName(base: string, used: Set<string>): string {
  let name = base.replace(/[[\]:*?/\\]/g, '').replace(/\s+/g, ' ').trim()
  name = name.replace(/^'+|'+$/g, '').trim() || 'Sheet'
  const cut = (s: string, max: number) => [...s].slice(0, max).join('').trim()
  let candidate = cut(name, SHEET_NAME_MAX)
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`
    candidate = cut(name, SHEET_NAME_MAX - suffix.length) + suffix
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function plain(nodes: MNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'wikiLink') return n.data?.alias ?? n.value ?? ''
      if (n.type === 'break') return ' '
      if (n.type === 'html') return (n.value ?? '').replace(/<[^>]*>/g, '')
      if (typeof n.value === 'string') return n.value
      return plain(n.children)
    })
    .join('')
}

interface FoundTable {
  name: string
  rows: string[][]
}

/** Tables in document order with the nearest heading above them (else the page title). */
function collectTables(pages: ExportPageSource[]): Array<{ base: string; rows: string[][] }> {
  const out: Array<{ base: string; rows: string[][] }> = []
  for (const page of pages) {
    const root = markdownProcessor.runSync(markdownProcessor.parse(page.markdown)) as unknown as MNode
    let heading = page.title
    const walk = (node: MNode) => {
      for (const c of node.children ?? []) {
        if (c.type === 'heading') heading = plain(c.children).trim() || page.title
        else if (c.type === 'table') {
          out.push({ base: heading, rows: (c.children ?? []).map((r) => (r.children ?? []).map((cell) => plain(cell.children).trim())) })
        } else walk(c)
      }
    }
    walk(root)
  }
  return out
}

function cell(text: string, header: boolean, pctStyles: Set<number>): string {
  const p = text ? tag('text:p', {}, escapeXml(text)) : ''
  if (header) return tag('table:table-cell', { 'table:style-name': 'ce-head', 'office:value-type': 'string' }, p)
  if (!text) return tag('table:table-cell')
  const v = classifyCell(text)
  switch (v.type) {
    case 'float':
      return tag('table:table-cell', { 'office:value-type': 'float', 'office:value': String(v.value) }, p)
    case 'percentage':
      pctStyles.add(v.decimals)
      return tag(
        'table:table-cell',
        { 'table:style-name': `ce-pct${v.decimals}`, 'office:value-type': 'percentage', 'office:value': String(v.value) },
        p,
      )
    case 'date':
      return tag('table:table-cell', { 'table:style-name': 'ce-date', 'office:value-type': 'date', 'office:date-value': v.value }, p)
    case 'string':
      return tag('table:table-cell', { 'office:value-type': 'string' }, p)
  }
}

const NS = {
  'xmlns:office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  'xmlns:style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  'xmlns:text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  'xmlns:table': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  'xmlns:number': 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  'xmlns:fo': 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
}

function automaticStyles(pctStyles: Set<number>): string {
  const bold = tag('style:text-properties', {
    'fo:font-weight': 'bold',
    'style:font-weight-asian': 'bold',
    'style:font-weight-complex': 'bold',
  })
  const pct = [...pctStyles].sort((a, b) => a - b).flatMap((d) => [
    tag('number:percentage-style', { 'style:name': `N-pct${d}` }, [
      tag('number:number', { 'number:decimal-places': d, 'number:min-decimal-places': d, 'number:min-integer-digits': 1 }),
      tag('number:text', {}, '%'),
    ]),
    tag('style:style', { 'style:name': `ce-pct${d}`, 'style:family': 'table-cell', 'style:data-style-name': `N-pct${d}` }),
  ])
  return tag('office:automatic-styles', {}, [
    tag('number:date-style', { 'style:name': 'N-date' }, [
      tag('number:year', { 'number:style': 'long' }),
      tag('number:text', {}, '-'),
      tag('number:month', { 'number:style': 'long' }),
      tag('number:text', {}, '-'),
      tag('number:day', { 'number:style': 'long' }),
    ]),
    tag('style:style', { 'style:name': 'ce-head', 'style:family': 'table-cell' }, bold),
    tag('style:style', { 'style:name': 'ce-date', 'style:family': 'table-cell', 'style:data-style-name': 'N-date' }),
    ...pct,
  ])
}

/** The Flat ODS; throws `NoTablesError` when the pages hold no table. */
export function buildFods(pages: ExportPageSource[]): string {
  const tables = collectTables(pages)
  if (tables.length === 0) throw new NoTablesError()
  const used = new Set<string>()
  const pctStyles = new Set<number>()
  const sheets: FoundTable[] = tables.map((t) => ({ name: sheetName(t.base, used), rows: t.rows }))
  const xmlSheets = sheets.map((s) => {
    const cols = Math.max(1, ...s.rows.map((r) => r.length))
    const rows = s.rows.map((r, ri) =>
      tag(
        'table:table-row',
        {},
        Array.from({ length: cols }, (_, c) => cell(r[c] ?? '', ri === 0, pctStyles)),
      ),
    )
    return tag('table:table', { 'table:name': s.name }, [
      tag('table:table-column', { 'table:number-columns-repeated': cols > 1 ? cols : undefined }),
      ...rows,
    ])
  })
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    tag('office:document', { ...NS, 'office:version': '1.3', 'office:mimetype': 'application/vnd.oasis.opendocument.spreadsheet' }, [
      automaticStyles(pctStyles),
      tag('office:body', {}, tag('office:spreadsheet', {}, xmlSheets)),
    ])
  )
}
