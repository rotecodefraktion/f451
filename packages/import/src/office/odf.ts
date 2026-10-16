// What the adapter reads from the ODF copy of the document (`document.<odt|odp|ods>`
// in the convert service's bundle): the title, the slides' frames (to tell
// title, outline, notes and placeholders apart), text of shapes the XHTML
// export leaves out, sheet names, the frames that produce SVM images (for the
// chart matching) and constructs that are dropped and counted.

import { strFromU8, unzipSync } from 'fflate'
import { parseChart, type SvmFrame } from './charts.js'
import { xmlEvents } from './xml.js'

export interface OdfFrame {
  /** `draw:name`; '' if the frame has none. */
  name: string
  /** `presentation:class` (title, outline, notes, page-number, …); '' if none. */
  cls: string
  inNotes: boolean
}

export interface OdfPage {
  name: string
  /** Frames directly on the slide or its notes, in document order. */
  frames: OdfFrame[]
  /** Paragraphs of shapes outside frames (custom shapes, SmartArt parts). */
  shapeTexts: string[]
  /** `draw:plugin` targets (embedded video and audio). */
  media: string[]
}

export interface OdfScan {
  /** `dc:title` from meta.xml; null if absent or empty. */
  title: string | null
  pages: OdfPage[]
  /** Sheet names in document order (spreadsheets). */
  sheets: string[]
  svmFrames: SvmFrame[]
  /** Dropped constructs by kind: animation, transition, macro, ole, formControl. */
  dropped: Record<string, number>
}

const SHAPES = new Set([
  'draw:custom-shape',
  'draw:rect',
  'draw:ellipse',
  'draw:circle',
  'draw:polygon',
  'draw:polyline',
  'draw:path',
  'draw:regular-polygon',
  'draw:caption',
  'draw:line',
  'draw:connector',
])

const BASIC_MODULE = /^(?:Basic|Scripts)\/.+\/(?!script-lb\.xml$|dialog-lb\.xml$)[^/]+$/

function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n
}

export function emptyScan(): OdfScan {
  return { title: null, pages: [], sheets: [], svmFrames: [], dropped: {} }
}

/** Never throws: an unreadable document gives an empty scan. */
export function scanOdf(odf: Uint8Array): OdfScan {
  const scan = emptyScan()
  let files: Record<string, Uint8Array>
  let macros = false
  try {
    files = unzipSync(odf, {
      filter: (f) => {
        if (BASIC_MODULE.test(f.name)) macros = true
        return f.name === 'content.xml' || f.name === 'meta.xml' || /^[^/]+\/content\.xml$/.test(f.name)
      },
    })
  } catch {
    return scan
  }
  if (macros) bump(scan.dropped, 'macro')
  try {
    if (files['meta.xml']) scan.title = readTitle(strFromU8(files['meta.xml']))
    if (files['content.xml']) scanContent(strFromU8(files['content.xml']), scan, files)
  } catch {
    return emptyScan()
  }
  return scan
}

function readTitle(xml: string): string | null {
  let buf: string | null = null
  for (const ev of xmlEvents(xml)) {
    if (ev.type === 'open' && ev.name === 'dc:title' && !ev.selfClosing) buf = ''
    else if (ev.type === 'text' && buf !== null) buf += ev.value
    else if (ev.type === 'close' && ev.name === 'dc:title' && buf !== null) {
      const t = buf.replace(/\s+/g, ' ').trim()
      return t || null
    }
  }
  return null
}

interface FrameInfo {
  object: 'chart-or-object' | 'ole' | null
  href: string
  svm: boolean
  table: boolean
}

interface Open {
  name: string
  shape: boolean
}

function scanContent(xml: string, scan: OdfScan, files: Record<string, Uint8Array>): void {
  const transitionStyles = new Set<string>()
  let styleName: string | null = null
  let page: (OdfPage & { style: string; animated: boolean }) | null = null
  const pages: Array<OdfPage & { style: string; animated: boolean }> = []
  let notes = 0
  let shapes = 0
  let para: string | null = null
  const frameStack: FrameInfo[] = []
  const candidates: FrameInfo[] = []
  const stack: Open[] = []

  for (const ev of xmlEvents(xml)) {
    if (ev.type === 'text') {
      if (para !== null) para += ev.value
      continue
    }
    if (ev.type === 'close') {
      const open = stack.pop()
      if (open?.shape) shapes--
      switch (ev.name) {
        case 'text:p':
        case 'text:h':
          if (para !== null) {
            const t = para.replace(/[ \t]+/g, ' ').trim()
            if (t && page) page.shapeTexts.push(t)
            para = null
          }
          break
        case 'draw:frame':
          frameStack.pop()
          break
        case 'presentation:notes':
          notes = Math.max(0, notes - 1)
          break
        case 'draw:page':
          page = null
          break
        case 'style:style':
          styleName = null
          break
      }
      continue
    }

    const a = ev.attrs
    const parent = stack.at(-1)?.name
    let shape = false
    switch (ev.name) {
      case 'style:style':
        styleName = a['style:family'] === 'drawing-page' ? (a['style:name'] ?? null) : null
        break
      case 'style:drawing-page-properties': {
        const style = a['presentation:transition-style']
        if (styleName && (a['smil:type'] || (style && style !== 'none'))) transitionStyles.add(styleName)
        break
      }
      case 'draw:page': {
        const p: OdfPage & { style: string; animated: boolean } = {
          name: a['draw:name'] ?? '',
          frames: [],
          shapeTexts: [],
          media: [],
          style: a['draw:style-name'] ?? '',
          animated: false,
        }
        pages.push(p)
        if (!ev.selfClosing) page = p
        break
      }
      case 'presentation:notes':
        if (!ev.selfClosing) notes++
        break
      case 'draw:frame': {
        const info: FrameInfo = { object: null, href: '', svm: false, table: false }
        candidates.push(info)
        if (page && frameStack.length === 0) {
          page.frames.push({ name: a['draw:name'] ?? '', cls: a['presentation:class'] ?? '', inNotes: notes > 0 })
        }
        if (!ev.selfClosing) frameStack.push(info)
        break
      }
      case 'draw:object':
      case 'draw:object-ole': {
        const f = frameStack.at(-1)
        if (f) {
          f.object = ev.name === 'draw:object-ole' ? 'ole' : 'chart-or-object'
          f.href = a['xlink:href'] ?? ''
        }
        break
      }
      case 'draw:image': {
        const f = frameStack.at(-1)
        const href = a['xlink:href'] ?? ''
        if (f && (/\.svm$/i.test(href) || /ObjectReplacements\//.test(href))) f.svm = true
        break
      }
      case 'table:table':
        if (frameStack.length) frameStack[frameStack.length - 1].table = true
        else if (parent === 'office:spreadsheet') scan.sheets.push(a['table:name'] ?? '')
        break
      case 'draw:plugin':
        if (page && a['xlink:href']) page.media.push(a['xlink:href'])
        break
      case 'anim:par':
        if (page) page.animated = true
        break
      case 'draw:control':
        bump(scan.dropped, 'formControl')
        break
      case 'text:p':
      case 'text:h':
        if (shapes > 0 && frameStack.length === 0 && !ev.selfClosing) para = ''
        break
      case 'text:s':
        if (para !== null) para += ' '.repeat(Math.min(Number.parseInt(a['text:c'] ?? '1', 10) || 1, 100))
        break
      case 'text:tab':
        if (para !== null) para += '\t'
        break
      case 'text:line-break':
        if (para !== null) para += '\n'
        break
    }
    if (SHAPES.has(ev.name) && page && frameStack.length === 0 && !ev.selfClosing) {
      shapes++
      shape = true
    }
    if (!ev.selfClosing) stack.push({ name: ev.name, shape })
  }

  for (const p of pages) {
    if (p.animated) bump(scan.dropped, 'animation')
    if (p.style && transitionStyles.has(p.style)) bump(scan.dropped, 'transition')
    scan.pages.push({ name: p.name, frames: p.frames, shapeTexts: p.shapeTexts, media: p.media })
  }

  for (const c of candidates) {
    if (c.object === 'ole') {
      bump(scan.dropped, 'ole')
      scan.svmFrames.push({ kind: 'other', title: null, data: null })
    } else if (c.object) {
      const path = `${c.href.replace(/^\.\//, '').replace(/\/+$/, '')}/content.xml`
      const bytes = files[path]
      const chart = bytes ? parseChart(strFromU8(bytes)) : null
      if (chart) scan.svmFrames.push({ kind: 'chart', title: chart.title, data: chart.data })
      else {
        bump(scan.dropped, 'ole')
        scan.svmFrames.push({ kind: 'other', title: null, data: null })
      }
    } else if (c.svm) {
      scan.svmFrames.push({ kind: c.table ? 'table' : 'other', title: null, data: null })
    }
  }
}
