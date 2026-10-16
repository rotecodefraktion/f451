// Pre-pass on LibreOffice's Calc HTML (spec 2026-10-16-office-import §3
// "Spreadsheets"): the overview at the top goes; each sheet (`<a name="tableN">`
// with an `<h1>` holding the name in `<em>`) becomes a part with one table,
// the first row as header. Cells hold what Calc displays (formula results,
// formatted numbers and dates).

import type { OfficeDoc, OfficePart } from './doc.js'
import { collapse, el, findAll, isBlank, isElement, prop, serialize, textOf, txt, type HElement, type HNode } from './hast.js'

export const MAX_SHEET_ROWS = 2000
const MAX_SPAN = 1000

export interface SheetsResult extends OfficeDoc {
  /** Sheets without cells, in document order; they are not imported. */
  empty: string[]
  /** Sheets cut at `MAX_SHEET_ROWS`; `part` is the index into `parts`. */
  truncated: Array<{ part: number; sheet: string; rows: number }>
}

function isSheetMarker(n: HNode): n is HElement {
  if (isElement(n, 'a') && /^table\d+$/i.test(prop(n, 'name'))) return true
  return isElement(n, 'a') && findAll(n, (e) => e.tagName === 'h1').length > 0
}

function sheetName(marker: HElement): string {
  const h1 = isElement(marker, 'h1') ? marker : findAll(marker, (e) => e.tagName === 'h1')[0]
  if (!h1) return collapse(textOf(marker))
  const em = findAll(h1, (e) => e.tagName === 'em')[0]
  if (em) return collapse(textOf(em))
  return collapse(textOf(h1)).replace(/^[^:]*:\s*/, '')
}

function rowsOf(table: HElement): HElement[] {
  const rows: HElement[] = []
  for (const c of table.children) {
    if (isElement(c, 'tr')) rows.push(c)
    else if (isElement(c, 'thead') || isElement(c, 'tbody') || isElement(c, 'tfoot')) {
      rows.push(...c.children.filter((r): r is HElement => isElement(r, 'tr')))
    }
  }
  return rows
}

function span(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 1 ? Math.min(Math.floor(n), MAX_SPAN) : 1
}

/** Cell content: `<br>` becomes a space (an empty cell holds only `<br>`). */
function cellContent(cell: HElement): HNode[] {
  if (isBlank(cell)) return []
  const replace = (nodes: HNode[]): HNode[] =>
    nodes.map((n) => (isElement(n, 'br') ? txt(' ') : isElement(n) ? { ...n, children: replace(n.children) } : n))
  return replace(cell.children)
}

/** The table as a grid; a merged cell keeps its value in the first cell, the
 *  cells it covers stay empty. */
function grid(table: HElement): HNode[][][] {
  const out: HNode[][][] = []
  const covered = new Set<string>()
  for (const [r, tr] of rowsOf(table).entries()) {
    const row: HNode[][] = (out[r] ??= [])
    let c = 0
    for (const cell of tr.children) {
      if (!isElement(cell, 'td') && !isElement(cell, 'th')) continue
      while (covered.has(`${r}:${c}`)) {
        row[c] ??= []
        c++
      }
      const cs = span(cell.properties.colSpan)
      const rs = span(cell.properties.rowSpan)
      row[c] = cellContent(cell)
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) if (dr || dc) covered.add(`${r + dr}:${c + dc}`)
      }
      for (let dc = 1; dc < cs; dc++) row[c + dc] = []
      c += cs
    }
  }
  return out.map((row) => Array.from({ length: row.length }, (_, i) => row[i] ?? []))
}

function filled(cell: HNode[] | undefined): boolean {
  return !!cell && cell.some((n) => !isBlank(n))
}

/** Trims empty trailing rows and columns; null if no cell holds anything. */
function trim(rows: HNode[][][]): HNode[][][] | null {
  let height = rows.length
  while (height > 0 && !rows[height - 1].some(filled)) height--
  let width = 0
  for (const row of rows.slice(0, height)) {
    for (let i = row.length - 1; i >= width; i--) {
      if (filled(row[i])) {
        width = i + 1
        break
      }
    }
  }
  if (height === 0 || width === 0) return null
  return rows.slice(0, height).map((row) => Array.from({ length: width }, (_, i) => row[i] ?? []))
}

function toTable(rows: HNode[][][]): HElement {
  const [head, ...body] = rows
  return el('table', {}, [
    el('thead', {}, [el('tr', {}, head.map((c) => el('th', {}, c)))]),
    el('tbody', {}, body.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))),
  ])
}

/** `odfSheets` are the sheet names of the ODF copy: sheets Calc leaves out of
 *  the HTML (empty ones) are listed in `empty`. */
export function sheetsPrepass(body: HElement, odfSheets: string[]): SheetsResult {
  const sections: Array<{ name: string; nodes: HNode[] }> = []
  for (const n of body.children) {
    if (isSheetMarker(n)) sections.push({ name: sheetName(n), nodes: [] })
    // Everything before the first sheet is Calc's overview.
    else if (sections.length) sections[sections.length - 1].nodes.push(n)
  }

  const result: SheetsResult = { intro: '', parts: [], empty: [], truncated: [] }
  const seen = new Set<string>()
  for (const s of sections) {
    seen.add(s.name)
    const blocks: HNode[] = []
    for (const n of s.nodes) {
      if (isElement(n, 'table')) {
        let rows = trim(grid(n))
        if (!rows) continue
        if (rows.length > MAX_SHEET_ROWS) {
          result.truncated.push({ part: result.parts.length, sheet: s.name, rows: rows.length })
          rows = rows.slice(0, MAX_SHEET_ROWS)
        }
        blocks.push(toTable(rows))
      } else if (!isElement(n, 'hr') && !isBlank(n)) blocks.push(n)
    }
    if (blocks.length === 0) {
      result.empty.push(s.name)
      continue
    }
    const part: OfficePart = {
      title: s.name,
      heading: serialize([el('h2', {}, [txt(s.name)])]),
      html: serialize(blocks),
    }
    result.parts.push(part)
  }
  for (const name of odfSheets) if (!seen.has(name)) result.empty.push(name)
  const order = (name: string): number => {
    const i = odfSheets.indexOf(name)
    return i < 0 ? odfSheets.length : i
  }
  result.empty.sort((a, b) => order(a) - order(b))
  return result
}
