import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { FileSource } from '../files/source.js'
import type { ImportNode } from '../model.js'
import { ConvertError, type Converter, type HtmlBundle } from './converter.js'
import { fromOutDir, loadOfficeTree } from './index.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/office')
// The fixtures are about the mapping; the ZIP check has its own test below.
const LIMITS = { maxRatio: 1000 }

function fixtureBundle(dir: string): HtmlBundle {
  const base = join(FIX, dir)
  const media = new Map<string, Uint8Array>()
  const mediaDir = join(base, 'media')
  if (existsSync(mediaDir)) {
    for (const f of readdirSync(mediaDir)) media.set(`media/${f}`, new Uint8Array(readFileSync(join(mediaDir, f))))
  }
  const odfName = readdirSync(base).find((f) => /^document\.(odt|odp|ods)$/.test(f))!
  return {
    html: readFileSync(join(base, 'document.html'), 'utf8'),
    media,
    odf: new Uint8Array(readFileSync(join(base, odfName))),
    odfExt: odfName.slice('document.'.length) as HtmlBundle['odfExt'],
  }
}

const FIXTURE_BUNDLES: Record<string, string> = { 'report.docx': 'report', 'deck.pptx': 'deck', 'book.xlsx': 'book' }

function converter(bundles: Record<string, () => HtmlBundle> = {}, calls: string[] = []): Converter {
  return {
    async toHtml(_bytes, name) {
      calls.push(name)
      if (bundles[name]) return bundles[name]()
      const dir = FIXTURE_BUNDLES[name]
      if (!dir) throw new ConvertError('unsupported file type', 400)
      return fixtureBundle(dir)
    },
    async fromBundle() {
      throw new Error('not used')
    },
  }
}

function source(files: Record<string, Uint8Array>): FileSource {
  return {
    list: async () => Object.keys(files).sort(),
    read: async (path) => {
      const v = files[path]
      if (!v) throw new Error(`not listed: ${path}`)
      return v
    },
  }
}

function fixtureFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIX, name)))
}

/** Bytes that do not compress, so a test ZIP stays below the ratio limit. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = 12345
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

function section(md: string, from: string, to?: string): string {
  const start = md.indexOf(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = to ? md.indexOf(to, start + from.length) : -1
  return md.slice(start, end < 0 ? undefined : end)
}

function titles(nodes: ImportNode[]): string[] {
  return nodes.map((n) => n.title)
}

describe('fromOutDir', () => {
  it('turns links relative to the runner output back into document-relative ones', () => {
    expect(fromOutDir('../in/deck.pptx')).toBe('deck.pptx')
    expect(fromOutDir('../in/sub/a.docx#x')).toBe('sub/a.docx#x')
    expect(fromOutDir('../other.docx')).toBe('../other.docx')
    expect(fromOutDir('https://example.org/a')).toBe('https://example.org/a')
    expect(fromOutDir('#anchor')).toBe('#anchor')
  })
})

describe('loadOfficeTree — text', () => {
  const files = { 'report.docx': fixtureFile('report.docx') }

  it('converts footnotes, endnotes, nested lists, comments, images and tables', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: false, limits: LIMITS })
    expect(tree.failed).toEqual([])
    const [page] = tree.root
    expect(page.title).toBe('Quartalsbericht')
    expect(page.sourceRef).toEqual({ type: 'office', id: 'office:report.docx' })
    const md = page.markdown
    expect(md.startsWith('# Quartalsbericht\n')).toBe(true)
    expect(md).toContain('Vorwort vor dem ersten Kapitel.')
    // One page: the page title is the only H1, the chapters move one level down.
    expect(md).toContain('\n## Einleitung\n')
    expect(md).toContain('\n## Ergebnis\n')
    expect(md).toContain('Fußnote[^1]')
    expect(md).toContain('[^1]: Quelle: Archiv.')
    expect(md).toContain('Ende.[^e1]')
    expect(md).toContain('[^e1]: Eine Endnote.')
    expect(md).toContain('- Punkt eins\n  - Unterpunkt\n- Punkt zwei')
    expect(md).toContain('und Kommentar.')
    expect(md).not.toContain('Bitte prüfen')
    expect(tree.droppedHtml.comment).toBe(1)
    expect(md).toMatch(/\| Name +\| Wert +\|/)
    expect(md).toContain('](_media/document_html_32f32c6a.png)')
    expect(page.media.map((m) => [m.name, m.kind])).toEqual([['document_html_32f32c6a.png', 'image']])
    // The sibling file is not part of this import: the link stays text and is reported.
    expect(tree.unresolved).toContainEqual({ sourceId: 'office:report.docx', target: 'deck.pptx' })
  })

  it('splits at H1; content before the first H1 stays on the file page', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: true, limits: LIMITS })
    const [page] = tree.root
    expect(page.markdown).toContain('Vorwort vor dem ersten Kapitel.')
    expect(page.markdown).not.toContain('Einleitung')
    expect(titles(page.children)).toEqual(['Einleitung', 'Ergebnis'])
    expect(page.children.map((c) => c.sourceRef.id)).toEqual(['office:report.docx@1', 'office:report.docx@2'])
    const [intro, result] = page.children
    expect(intro.markdown.startsWith('# Einleitung\n')).toBe(true)
    expect(intro.markdown).toContain('[^1]: Quelle: Archiv.')
    expect(intro.markdown).not.toContain('[^e1]')
    expect(intro.media.map((m) => m.name)).toEqual(['document_html_32f32c6a.png'])
    expect(result.markdown).toContain('[^e1]: Eine Endnote.')
  })

  it('links to a sibling Office file of the same ZIP become placeholders', async () => {
    const tree = await loadOfficeTree(source({ ...files, 'deck.pptx': fixtureFile('deck.pptx') }), {
      converter: converter(),
      split: false,
      limits: LIMITS,
    })
    const report = tree.root.find((n) => n.title === 'Quartalsbericht')!
    expect(report.markdown).toContain('[die Präsentation](source:office:deck.pptx|deck.pptx)')
    expect(tree.unresolved).toEqual([])
  })
})

describe('loadOfficeTree — Word structure', () => {
  const HTML =
    '<html><body>' +
    '<div title="header"><p><img src="media/logo.png" name="Grafik 1"></p></div>' +
    '<p><img src="media/s.gif" name="Shape1" alt="Shape1"></p><p>Cover title</p>' +
    '<div id="Table of Contents1"><div id="TextSection"><p>TABLE OF CONTENTS</p></div>' +
    '<p><a href="#_Toc1">1\tIntro\t3</a></p><p><a href="#_Toc2">1.1\tScope\t4</a></p></div>' +
    '<h1><a name="_Toc1"></a>1Intro</h1><p>See <a href="#_Toc2">the scope</a> and <a href="#_Ref9">a bookmark</a>.</p>' +
    '<h2><a name="_Toc2"></a>1.1<span>Scope</span> </h2><p>Text\u0001 here.</p>' +
    '<h1>2Intro</h1><p>Back to <a href="#_Toc1">the intro</a>.</p>' +
    '<div title="footer"><p>Internal 1 | 8</p></div>' +
    '</body></html>'
  const odt = zipSync({ 'content.xml': strToU8('<office:document-content/>') })
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      '<w:document><w:body><w:p><w:r><w:t>Status </w:t></w:r><w:del w:id="1"><w:r><w:delText>Final</w:delText></w:r></w:del></w:p></w:body></w:document>',
    ),
    'word/media/pad.bin': noise(500),
  })
  const run = async (split: boolean, seen: Uint8Array[] = []) => {
    const conv: Converter = {
      async toHtml(bytes) {
        seen.push(bytes)
        return { html: HTML, media: new Map(), odf: odt, odfExt: 'odt' }
      },
      async fromBundle() {
        throw new Error('not used')
      },
    }
    return loadOfficeTree(source({ 'g.docx': docx }), { converter: conv, split, limits: LIMITS })
  }

  it('accepts tracked changes before the conversion', async () => {
    const seen: Uint8Array[] = []
    const tree = await run(false, seen)
    const xml = new TextDecoder().decode(unzipSync(seen[0])['word/document.xml'])
    expect(xml).toContain('Status ')
    expect(xml).not.toContain('Final')
    expect(tree.droppedHtml.trackedChange).toBe(1)
  })

  it('drops the table of contents, separates outline numbers and links headings by their anchors', async () => {
    const md = (await run(false)).root[0].markdown
    expect(md).not.toContain('TABLE OF CONTENTS')
    expect(md).not.toContain('_Toc')
    expect(md).toContain('\n## 1 Intro\n')
    expect(md).toContain('\n### 1.1 Scope\n')
    expect(md).toContain('\n## 2 Intro\n')
    expect(md).toContain('Back to [the intro](#1-intro).')
    expect(md).toContain('See [the scope](#11-scope) and a bookmark.')
    expect(md).toContain('Text here.')
    expect(md).not.toMatch(/F451X|f451-heading/)
  })

  it('drops the page header and footer and drawing shapes Writer rendered as images', async () => {
    const tree = await run(false)
    const md = tree.root[0].markdown
    expect(md).toContain('Cover title')
    expect(md).not.toContain('Internal 1')
    expect(md).not.toMatch(/logo\.png|s\.gif|Shape1/)
    expect(tree.droppedHtml.pageHeaderFooter).toBe(2)
    expect(tree.droppedHtml.shape).toBe(1)
  })

  it('keeps only the text of a link to a heading on another page when splitting', async () => {
    const tree = await run(true)
    const [first, second] = tree.root[0].children
    expect(first.title).toBe('1 Intro')
    expect(first.markdown).toContain('See [the scope](#11-scope)')
    expect(second.title).toBe('2 Intro')
    expect(second.markdown).toContain('Back to the intro.')
    expect(tree.root[0].children.map((c) => c.markdown).join('')).not.toMatch(/F451X|f451-heading/)
  })
})

describe('loadOfficeTree — slides', () => {
  const files = { 'deck.pptx': fixtureFile('deck.pptx') }

  it('makes one section per slide with outline levels and speaker notes', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: false, limits: LIMITS })
    expect(tree.failed).toEqual([])
    const md = tree.root[0].markdown
    const agenda = section(md, '## Agenda', '## Zahlen')
    expect(agenda).toContain('- Ziele\n  - Umsatz\n    - Kosten\n- Termine')
    expect(agenda).toContain('> [!NOTE]\n> **Speaker notes**\n>\n> Kurz halten.')
    expect(md).not.toContain('•')
    expect(md).not.toContain('–')
    // Slide number placeholder removed.
    expect(md).not.toMatch(/number>/)
    expect(md).toContain('## Slide 3')
    expect(section(md, '## Slide 3', '## Tabelle')).toContain('](_media/img-1.png)')
  })

  it('keeps the chart image with its data table and drops the table preview image', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: false, limits: LIMITS })
    const md = tree.root[0].markdown
    const zahlen = section(md, '## Zahlen', '## Slide 3')
    expect(zahlen).toContain('](_media/chart-1.svg)')
    expect(zahlen).toMatch(/^\|.*\|$/m)
    expect(zahlen).not.toContain('LibreOffice/')
    const tabelle = section(md, '## Tabelle')
    expect(tabelle).toMatch(/\| Name +\| Wert +\|/)
    expect(tabelle).not.toContain('chart-2.svg')
    expect(tree.root[0].media.map((m) => m.name).sort()).toEqual(['chart-1.svg', 'img-1.png'])
    expect(tree.mediaSkipped.filter((m) => m.name === 'chart data')).toEqual([])
  })

  it('names untitled slides in the space language', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: false, lang: 'de', limits: LIMITS })
    expect(tree.root[0].markdown).toContain('## Folie 3')
  })

  it('splits into one page per slide', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: true, limits: LIMITS })
    const [page] = tree.root
    expect(page.markdown.trim()).toBe(`# ${page.title}`)
    expect(titles(page.children)).toEqual(['Agenda', 'Zahlen', 'Slide 3', 'Tabelle'])
    expect(page.children.map((c) => c.sourceRef.id)).toEqual([1, 2, 3, 4].map((n) => `office:deck.pptx@${n}`))
    expect(page.children[0].markdown).toContain('# Agenda')
    expect(page.children[0].markdown).toContain('> [!NOTE]\n> **Speaker notes**')
    expect(page.children[2].media.map((m) => m.name)).toEqual(['img-1.png'])
  })

  it('attaches embedded video to its slide, the rest at the end of the page', async () => {
    const pptx = zipSync({
      // Every real package has root entries, so the ZIP reader strips no wrapper folder.
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'),
      'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld/>'),
      'ppt/slides/_rels/slide1.xml.rels': strToU8('<Relationships><Relationship Id="rId3" Target="../media/media1.mp4"/></Relationships>'),
      'ppt/media/media1.mp4': noise(2000),
      'ppt/media/other.mp3': noise(2000),
    })
    const tree = await loadOfficeTree(source({ 'deck.pptx': pptx }), { converter: converter(), split: false, limits: LIMITS })
    const md = tree.root[0].markdown
    expect(section(md, '## Agenda', '## Zahlen')).toContain('### Anhänge\n\n- [media1.mp4](_media/media1.mp4)')
    expect(md.trimEnd().endsWith('## Anhänge\n\n- [other.mp3](_media/other.mp3)')).toBe(true)
    const video = tree.root[0].media.find((m) => m.name === 'media1.mp4')!
    expect(video.mime).toBe('video/mp4')
    expect(video.kind).toBe('file')
  })
})

describe('loadOfficeTree — sheets', () => {
  const files = { 'book.xlsx': fixtureFile('book.xlsx') }

  it('makes a section per sheet with the first row as header and displayed values', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: false, limits: LIMITS })
    expect(tree.failed).toEqual([])
    const md = tree.root[0].markdown
    expect(md).not.toContain('Overview')
    const daten = section(md, '## Daten', '## Summe')
    expect(daten).toMatch(/\| Artikel +\| Menge +\| Datum +\|\n\| -+ +\| -+ +\| -+ +\|/)
    expect(daten).toContain('01.10.2026')
    // Merged cell: the value in the first cell, the covered one empty.
    expect(daten).toMatch(/\| Zusammen +\| +\| +\|/)
    const summe = section(md, '## Summe')
    expect(summe).toMatch(/\| Gesamt +\|/)
    expect(summe).toMatch(/\| 8 +\|/)
    expect(summe).not.toContain('SUM')
    expect(md).not.toContain('## Leer')
    expect(tree.mediaSkipped).toContainEqual({ sourceId: 'office:book.xlsx', name: 'sheet "Leer"', reason: 'empty, not imported' })
    expect(tree.droppedHtml.colspan).toBeUndefined()
  })

  it('splits into one page per sheet', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: true, limits: LIMITS })
    expect(titles(tree.root[0].children)).toEqual(['Daten', 'Summe'])
    expect(tree.root[0].children[1].markdown).toMatch(/^# Summe\n/)
  })

  it('cuts sheets after 2,000 rows and reports them', async () => {
    const rows = ['<tr><td>H</td></tr>', ...Array.from({ length: 2100 }, (_, i) => `<tr><td>r${i + 1}</td></tr>`)]
    const html = `<html><body><a name="table0"><h1>Sheet 1: <em>Big</em></h1></a><table>${rows.join('')}</table></body></html>`
    const odf = zipSync({
      'content.xml': strToU8(
        '<office:document-content><office:body><office:spreadsheet><table:table table:name="Big"/></office:spreadsheet></office:body></office:document-content>',
      ),
    })
    const tree = await loadOfficeTree(source({ 'big.xlsx': zipSync({ 'xl/workbook.xml': noise(500) }) }), {
      converter: converter({ 'big.xlsx': () => ({ html, media: new Map(), odf, odfExt: 'ods' }) }),
      split: false,
      limits: LIMITS,
    })
    expect(tree.truncated).toEqual([{ sourceId: 'office:big.xlsx', sheet: 'Big', rows: 2101 }])
    expect(tree.root[0].markdown).toMatch(/\| r1999 +\|/)
    expect(tree.root[0].markdown).not.toMatch(/\| r2000 +\|/)
  })
})

describe('loadOfficeTree — charts', () => {
  const CHART = `<office:document-content><office:body><office:chart><chart:chart>
<chart:title><text:p>Umsatz</text:p></chart:title><chart:plot-area/>
<table:table table:name="local-table">
<table:table-header-rows><table:table-row><table:table-cell><text:p/></table:table-cell><table:table-cell office:value-type="string"><text:p>2025</text:p></table:table-cell></table:table-row></table:table-header-rows>
<table:table-rows><table:table-row><table:table-cell office:value-type="string"><text:p>Q1</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:table-cell></table:table-row></table:table-rows>
</table:table></chart:chart></office:chart></office:body></office:document-content>`
  const frame = (n: number): string =>
    `<draw:frame draw:name="Object${n}"><draw:object xlink:href="./Object ${n}"/><draw:image xlink:href="./ObjectReplacements/Object ${n}"/></draw:frame>`
  const odt = (charts: number): Uint8Array => {
    const files: Record<string, Uint8Array> = {
      'content.xml': strToU8(
        `<office:document-content><office:body><office:text><text:p>${Array.from({ length: charts }, (_, i) => frame(i + 1)).join('')}</text:p></office:text></office:body></office:document-content>`,
      ),
    }
    for (let i = 1; i <= charts; i++) files[`Object ${i}/content.xml`] = strToU8(CHART)
    return zipSync(files)
  }
  const bundle = (charts: number) => (): HtmlBundle => ({
    html: '<html><body><p>Vorher</p><p><img src="media/chart-1.svg"></p><p>Nachher</p></body></html>',
    media: new Map([['media/chart-1.svg', strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')]]),
    odf: odt(charts),
    odfExt: 'odt',
  })
  const file = { 'c.odt': zipSync({ 'content.xml': noise(500) }) }

  it('adds the data table below a matched chart, with the chart title as alt text', async () => {
    const tree = await loadOfficeTree(source(file), { converter: converter({ 'c.odt': bundle(1) }), split: false, limits: LIMITS })
    const md = tree.root[0].markdown
    expect(md).toContain('![Umsatz](_media/chart-1.svg)')
    const table = section(md, '![Umsatz]', 'Nachher')
    expect(table).toMatch(/\| +\| 2025 +\|/)
    expect(table).toMatch(/\| Q1 +\| 4 +\|/)
  })

  it('adds no data tables when images and objects do not match, and says so', async () => {
    const tree = await loadOfficeTree(source(file), { converter: converter({ 'c.odt': bundle(2) }), split: false, limits: LIMITS })
    const md = tree.root[0].markdown
    expect(md).toContain('![Chart](_media/chart-1.svg)')
    expect(md).not.toContain('Q1')
    expect(tree.mediaSkipped.map((m) => m.name)).toContain('chart data')
  })
})

describe('loadOfficeTree — failures', () => {
  it('rejects an OOXML bomb before conversion', async () => {
    const calls: string[] = []
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(5_000_000) })
    const tree = await loadOfficeTree(source({ 'bomb.docx': bomb }), { converter: converter({}, calls), split: false })
    expect(calls).toEqual([])
    expect(tree.root).toEqual([])
    expect(tree.failed).toHaveLength(1)
    expect(tree.failed[0].sourceId).toBe('office:bomb.docx')
    expect(tree.failed[0].reason).toMatch(/rejected before conversion/)
  })

  it('lists a failed conversion and continues with the next file', async () => {
    const failing: Converter = {
      ...converter(),
      async toHtml(bytes, name) {
        if (name === 'book.xlsx') throw new ConvertError('conversion timed out', 504)
        return converter().toHtml(bytes, name)
      },
    }
    const tree = await loadOfficeTree(
      source({ 'book.xlsx': fixtureFile('book.xlsx'), 'report.docx': fixtureFile('report.docx') }),
      { converter: failing, split: false, limits: LIMITS },
    )
    expect(tree.failed).toEqual([{ sourceId: 'office:book.xlsx', title: 'book', reason: 'conversion timed out' }])
    expect(titles(tree.root)).toEqual(['Quartalsbericht'])
  })

  it('stops before the next conversion when the signal is aborted', async () => {
    const ctrl = new AbortController()
    const calls: string[] = []
    const conv = converter({}, calls)
    const aborting: Converter = {
      ...conv,
      async toHtml(bytes, name) {
        const r = await conv.toHtml(bytes, name)
        ctrl.abort()
        return r
      },
    }
    await expect(
      loadOfficeTree(source({ 'book.xlsx': fixtureFile('book.xlsx'), 'report.docx': fixtureFile('report.docx') }), {
        converter: aborting,
        split: false,
        limits: LIMITS,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow()
    expect(calls).toEqual(['book.xlsx'])
  })
})
