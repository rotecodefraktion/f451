// Charts: the SVG image the convert service made from LibreOffice's SVM
// preview, plus the chart data from the ODF document as a table below it
// (spec 2026-10-16-office-import §3 "Charts, SmartArt, media").
//
// The service numbers every SVM image (`media/chart-<n>.svg`, or a
// `data-f451-dropped="chart"` placeholder when it could not be made) in
// document order. The ODF frames that produce an SVM image are, in the same
// order: chart objects, other embedded objects, table previews (Impress shows a
// table both as HTML table and as SVM preview) and SVM pictures. If both counts
// agree, image n belongs to frame n; otherwise no data tables are added.

import { el, isElement, txt, type HElement, type HNode } from './hast.js'
import { xmlEvents } from './xml.js'

export interface SvmFrame {
  kind: 'chart' | 'table' | 'other'
  title: string | null
  /** Rows of the chart's data table; the first row holds the series names. */
  data: string[][] | null
}

export interface ChartData {
  title: string | null
  data: string[][] | null
}

const MAX_ROWS = 1000
const MAX_REPEAT = 100

function repeat(value: string | undefined): number {
  const n = Number.parseInt(value ?? '1', 10)
  return Number.isFinite(n) && n > 1 ? Math.min(n, MAX_REPEAT) : 1
}

/** Reads `Object N/content.xml`; null if the object is not a chart. */
export function parseChart(xml: string): ChartData | null {
  let isChart = false
  let title: string | null = null
  let titleBuf: string | null = null
  let tables = 0
  let done = false
  const rows: string[][] = []
  let row: string[] | null = null
  let rowRepeat = 1
  let cell: string | null = null
  let cellRepeat = 1
  const stack: string[] = []

  for (const ev of xmlEvents(xml)) {
    if (ev.type === 'text') {
      if (titleBuf !== null) titleBuf += ev.value
      else if (cell !== null) cell += ev.value
      continue
    }
    if (ev.type === 'open') {
      const parent = stack.at(-1)
      if (ev.name === 'office:chart') isChart = true
      else if (ev.name === 'chart:title' && parent === 'chart:chart' && title === null && !ev.selfClosing) titleBuf = ''
      else if (ev.name === 'text:p') {
        if (titleBuf) titleBuf += ' '
        else if (cell) cell += ' '
      } else if (ev.name === 'text:s') {
        if (titleBuf !== null) titleBuf += ' '
        else if (cell !== null) cell += ' '
      } else if (ev.name === 'table:table' && isChart && !done) tables++
      else if (tables > 0 && ev.name === 'table:table-row') {
        row = []
        rowRepeat = repeat(ev.attrs['table:number-rows-repeated'])
        if (ev.selfClosing) row = null
      } else if (tables > 0 && row && (ev.name === 'table:table-cell' || ev.name === 'table:covered-table-cell')) {
        cellRepeat = repeat(ev.attrs['table:number-columns-repeated'])
        if (ev.selfClosing) for (let i = 0; i < cellRepeat; i++) row.push('')
        else cell = ''
      }
      if (!ev.selfClosing) stack.push(ev.name)
      continue
    }
    stack.pop()
    if (ev.name === 'chart:title' && titleBuf !== null) {
      title = titleBuf.replace(/\s+/g, ' ').trim() || null
      titleBuf = null
    } else if ((ev.name === 'table:table-cell' || ev.name === 'table:covered-table-cell') && row && cell !== null) {
      const value = cell.replace(/\s+/g, ' ').trim()
      for (let i = 0; i < cellRepeat; i++) row.push(value)
      cell = null
    } else if (ev.name === 'table:table-row' && row) {
      for (let i = 0; i < rowRepeat && rows.length < MAX_ROWS; i++) rows.push([...row])
      row = null
    } else if (ev.name === 'table:table' && tables > 0) {
      tables--
      if (tables === 0) done = true
    }
  }
  if (!isChart) return null
  // Trailing empty columns (repeated empty cells) carry nothing.
  let width = 0
  for (const r of rows) {
    for (let i = r.length - 1; i >= width; i--) {
      if (r[i] !== '') {
        width = i + 1
        break
      }
    }
  }
  const data = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')).filter((r) => r.some((c) => c !== ''))
  return { title, data: data.length >= 2 && width >= 2 ? data : null }
}

/** A table with the first row as header (series names), first column the categories. */
export function dataTable(rows: string[][]): HElement {
  const cell = (tag: string, value: string): HElement => el(tag, {}, value ? [txt(value)] : [])
  const [head, ...body] = rows
  return el('table', {}, [
    el('thead', {}, [el('tr', {}, head.map((v) => cell('th', v)))]),
    el('tbody', {}, body.map((r) => el('tr', {}, r.map((v) => cell('td', v))))),
  ])
}

// Also after the adapter replaced the source by its media placeholder
// (`f451-media:media%2Fchart-1.svg`).
const CHART_SRC = /(?:^|:)media(?:\/|%2F)chart-\d+\.svg$/i

export function isChartImage(node: HNode): node is HElement {
  return isElement(node, 'img') && CHART_SRC.test(String(node.properties.src ?? ''))
}

/** Data table of a matched chart image; the slide pre-pass rebuilds frames and
 *  takes the table from here. */
export const chartTables = new WeakMap<HElement, HElement>()

export interface ChartResult {
  matched: boolean
  /** SVM images in the HTML (made and dropped). */
  images: number
  /** Images the service could not make (placeholders removed). */
  dropped: number
  /** Chart objects in the ODF document. */
  charts: number
}

interface Slot {
  node: HElement
  path: HElement[]
}

function collectSlots(root: HElement): Slot[] {
  const out: Slot[] = []
  const visit = (node: HElement, path: HElement[]): void => {
    for (const c of node.children) {
      if (!isElement(c)) continue
      const e: HElement = c
      const chart: boolean = isChartImage(e)
      if (chart || (e.tagName === 'span' && String(e.properties.dataF451Dropped ?? '') === 'chart')) {
        out.push({ node: e, path: [...path, node] })
      } else visit(e, [...path, node])
    }
  }
  visit(root, [])
  return out
}

function removeFrom(parent: HElement, node: HNode): void {
  const i = parent.children.indexOf(node)
  if (i >= 0) parent.children.splice(i, 1)
}

/** Matches the SVM images of `body` to the ODF frames: table previews are
 *  removed (the HTML table stays), chart images get the chart title as alt
 *  text and the data table after their paragraph. Dropped-image placeholders
 *  are removed and counted in `dropped.chart`. */
export function applyCharts(
  body: HElement,
  frames: SvmFrame[],
  chartLabel: string,
  dropped: Record<string, number>,
): ChartResult {
  const slots = collectSlots(body)
  const matched = slots.length === frames.length && slots.length > 0
  const result: ChartResult = {
    matched,
    images: slots.length,
    dropped: 0,
    charts: frames.filter((f) => f.kind === 'chart').length,
  }
  for (const [i, slot] of slots.entries()) {
    const frame = matched ? frames[i] : null
    const parent = slot.path[slot.path.length - 1]
    if (slot.node.tagName === 'span') {
      removeFrom(parent, slot.node)
      if (frame?.kind !== 'table') {
        result.dropped++
        dropped.chart = (dropped.chart ?? 0) + 1
      }
      continue
    }
    if (frame?.kind === 'table') {
      removeFrom(parent, slot.node)
      continue
    }
    const img = slot.node
    if (!String(img.properties.alt ?? '').trim()) img.properties.alt = frame?.title ?? chartLabel
    if (frame?.kind === 'chart' && frame.data) {
      const table = dataTable(frame.data)
      chartTables.set(img, table)
      const grand = slot.path[slot.path.length - 2]
      if (parent.tagName === 'p' && grand) grand.children.splice(grand.children.indexOf(parent) + 1, 0, table)
      else parent.children.splice(parent.children.indexOf(img) + 1, 0, table)
    }
  }
  return result
}
