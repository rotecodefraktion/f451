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
    expect(page.markdown).not.toMatch(/^#+ Einleitung/m)
    // The table of contents follows the content before the first part.
    // Its heading is in the detected document language (tested separately).
    const toc = page.markdown.search(/\n## Inhalt\n/)
    expect(toc).toBeGreaterThan(page.markdown.indexOf('Vorwort'))
    expect(page.markdown).toContain('[Einleitung](source:office:report.docx@1|#)')
    expect(page.markdown).toContain('[Ergebnis](source:office:report.docx@2|#)')
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

  it('links a heading on another page of the same document through a placeholder when splitting', async () => {
    const tree = await run(true)
    const [first, second] = tree.root[0].children
    expect(first.title).toBe('1 Intro')
    expect(first.markdown).toContain('See [the scope](#11-scope)')
    expect(second.title).toBe('2 Intro')
    // The target is the other page's title: the link goes to the page itself.
    expect(second.markdown).toContain('Back to [the intro](source:office:g.docx@1|#).')
    expect(tree.root[0].children.map((c) => c.markdown).join('')).not.toMatch(/F451X|f451-heading/)
  })
})

describe('loadOfficeTree — title paragraph and deep headings', () => {
  const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  const styles =
    '<w:styles><w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style>' +
    LEVELS.map(
      (n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`,
    ).join('') +
    '</w:styles>'
  const para = (style: string | null, text: string): string =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/styles.xml': strToU8(styles),
    'word/document.xml': strToU8(
      '<w:document><w:body>' +
        '<w:p><w:pPr><w:pStyle w:val="Titel"/></w:pPr><w:r><w:t>My</w:t><w:br/><w:t>Title</w:t></w:r></w:p>' +
        LEVELS.map((n) => para(`Heading${n}`, `Level ${n}`) + para(null, `text ${n}`)).join('') +
        '</w:body></w:document>',
    ),
    'word/media/pad.bin': noise(500),
  })
  // What LibreOffice writes for the marked package (probe 2026-10-18): the
  // Title paragraph and levels 7–9 as plain paragraphs, the tokens as text.
  const HTML =
    '<html><body>' +
    '<p style="margin-bottom: 0.21cm"><font face="Sans"><font size="4" style="font-size: 14pt">F451XTMy<br/>\nTitle</font></font></p>' +
    LEVELS.map((n) =>
      n <= 6 ? `<h${n}>Level ${n}</h${n}><p>text ${n}</p>` : `<p style="margin-top: 0.42cm">F451XL${n}XLevel ${n}</p><p>text ${n}</p>`,
    ).join('') +
    '</body></html>'
  const odt = zipSync({ 'content.xml': strToU8('<office:document-content/>') })
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
    return loadOfficeTree(source({ 'my-file.docx': docx }), { converter: conv, split, limits: LIMITS })
  }

  it('marks the Title paragraph and levels 7–9 in the package before the conversion', async () => {
    const seen: Uint8Array[] = []
    await run(false, seen)
    const xml = new TextDecoder().decode(unzipSync(seen[0])['word/document.xml'])
    expect(xml).toContain('<w:pStyle w:val="Titel"/></w:pPr><w:r><w:t>F451XT</w:t></w:r>')
    expect(xml).toContain('F451XL7X')
    expect(xml).toContain('F451XL9X')
    expect(xml).not.toContain('F451XL6X')
  })

  it('takes the title from the Title paragraph and turns headings past level 6 into bold paragraphs', async () => {
    const tree = await run(false)
    const [page] = tree.root
    expect(page.title).toBe('My Title')
    const md = page.markdown
    expect(md.startsWith('# My Title\n')).toBe(true)
    expect(md.split('My Title').length - 1).toBe(1)
    expect(md).toContain('\n## Level 1\n')
    expect(md).toContain('\n###### Level 5\n')
    // One page: level 6 moves down to 7 as well.
    for (const n of [6, 7, 8, 9]) expect(md).toContain(`\n**Level ${n}**\n`)
    expect(md).toContain('text 9')
    expect(md).not.toMatch(/F451X|f451-heading/)
    expect(tree.droppedHtml.headingTooDeep).toBe(4)
  })

  it('keeps levels up to 6 as headings when splitting', async () => {
    const tree = await run(true)
    const [page] = tree.root
    expect(page.title).toBe('My Title')
    expect(titles(page.children)).toEqual(['Level 1'])
    const md = page.children[0].markdown
    expect(md).toContain('\n###### Level 6\n')
    for (const n of [7, 8, 9]) expect(md).toContain(`\n**Level ${n}**\n`)
    expect(md).not.toMatch(/F451X|f451-heading/)
    expect(tree.droppedHtml.headingTooDeep).toBe(3)
  })
})

describe('loadOfficeTree — Word options', () => {
  // An invented guideline: Title paragraph, three chapters (the last without
  // number), sections down to level 3, a heading link across chapters.
  const HTML =
    '<html><body>' +
    '<p>F451XTNetwork Guide</p><p>Preface.</p>' +
    '<h1>1Objective</h1><p>See <a href="#_Toc5">remote</a>.</p>' +
    '<h2>1.1Scope</h2><p>Scope text.</p>' +
    '<h1>2Network Access</h1><p>Chapter two text.</p>' +
    '<h2><a name="_Toc5"></a>2.1Remote Access</h2><p>Remote text.</p>' +
    '<h3>2.1.1Remote Clients</h3><p>First client text.</p>' +
    '<h3>2.1.2Remote Clients</h3><p>Second client text.</p>' +
    '<h2>2.2Guests</h2><p>Guest text.</p>' +
    '<h1>Annex</h1><p>No number.</p>' +
    '</body></html>'
  const odt = zipSync({ 'content.xml': strToU8('<office:document-content/>') })
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8('<w:document><w:body/></w:document>'),
    'word/media/pad.bin': noise(500),
  })
  const conv: Converter = {
    async toHtml() {
      return { html: HTML, media: new Map(), odf: odt, odfExt: 'odt' }
    },
    async fromBundle() {
      throw new Error('not used')
    },
  }
  type Extra = Partial<Parameters<typeof loadOfficeTree>[1]>
  const run = (split: boolean, extra: Extra = {}, names = ['net-guide.docx']) =>
    loadOfficeTree(source(Object.fromEntries(names.map((n) => [n, docx]))), { converter: conv, split, limits: LIMITS, ...extra })
  const ID = 'office:net-guide.docx'

  it('takes the title from the Title paragraph and lists the chapters in a table of contents', async () => {
    const [page] = (await run(true)).root
    expect(page.title).toBe('Network Guide')
    expect(titles(page.children)).toEqual(['1 Objective', '2 Network Access', 'Annex'])
    expect(page.children.map((c) => c.sourceRef.id)).toEqual([`${ID}@1`, `${ID}@2`, `${ID}@3`])
    expect(page.markdown).toContain(
      [
        'Preface.',
        '',
        '## Contents',
        '',
        `- [1 Objective](source:${ID}@1|#)`,
        `  - [1.1 Scope](source:${ID}@1#11-scope|#)`,
        `- [2 Network Access](source:${ID}@2|#)`,
        `  - [2.1 Remote Access](source:${ID}@2#21-remote-access|#)`,
        `  - [2.2 Guests](source:${ID}@2#22-guests|#)`,
        `- [Annex](source:${ID}@3|#)`,
      ].join('\n'),
    )
    // Depth 2: level 3 is not listed.
    expect(page.markdown).not.toContain('Remote Clients')
  })

  it('links a heading on another subpage through a placeholder with its slug', async () => {
    const [objective] = (await run(true)).root[0].children
    expect(objective.markdown).toContain(`See [remote](source:${ID}@2#21-remote-access|#).`)
  })

  it('writes the table of contents to depth 1, in the document language, or not at all', async () => {
    const depth1 = (await run(true, { text: { tocDepth: 1 } })).root[0].markdown
    expect(depth1).toContain(`- [1 Objective](source:${ID}@1|#)\n- [2 Network Access](source:${ID}@2|#)\n- [Annex](source:${ID}@3|#)`)
    expect(depth1).not.toContain('#11-scope')
    // The text is English: the space language is only the fallback.
    const de = (await run(true, { lang: 'de' })).root[0].markdown
    expect(de).toContain('\n## Contents\n')
    const off = (await run(true, { text: { toc: false } })).root[0].markdown
    expect(off).not.toContain('## Contents')
    expect(off).not.toContain('source:')
  })

  it('drops the outline numbers when numbering is off; heading links still resolve', async () => {
    const md = (await run(false, { text: { numbering: false } })).root[0].markdown
    expect(md).toContain('\n## Objective\n')
    expect(md).toContain('\n### Scope\n')
    expect(md).toContain('\n### Remote Access\n')
    expect(md).toContain('See [remote](#remote-access).')
    expect(md).not.toMatch(/\d\.\d/)
  })

  it('nests the pages at split level 2 with dotted source ids', async () => {
    const [page] = (await run(true, { text: { splitLevel: 2 } })).root
    expect(titles(page.children)).toEqual(['1 Objective', '2 Network Access', 'Annex'])
    const [objective, network, annex] = page.children
    expect(titles(objective.children)).toEqual(['1.1 Scope'])
    expect(objective.children[0].sourceRef.id).toBe(`${ID}@1.1`)
    expect(titles(network.children)).toEqual(['2.1 Remote Access', '2.2 Guests'])
    expect(network.children.map((c) => c.sourceRef.id)).toEqual([`${ID}@2.1`, `${ID}@2.2`])
    // Intermediate pages hold their own text up to the next part.
    expect(network.markdown).toContain('Chapter two text.')
    expect(network.markdown).not.toContain('Remote')
    expect(annex.children).toEqual([])
    expect(annex.markdown).toContain('No number.')
    // Level 3 moves up to ## on the level-2 pages.
    const remote = network.children[0]
    expect(remote.markdown.startsWith('# 2.1 Remote Access\n')).toBe(true)
    expect(remote.markdown).toContain('\n## 2.1.1 Remote Clients\n')
    expect(page.markdown).toContain(
      [
        `- [2 Network Access](source:${ID}@2|#)`,
        `  - [2.1 Remote Access](source:${ID}@2.1|#)`,
        `    - [2.1.1 Remote Clients](source:${ID}@2.1#211-remote-clients|#)`,
        `    - [2.1.2 Remote Clients](source:${ID}@2.1#212-remote-clients|#)`,
        `  - [2.2 Guests](source:${ID}@2.2|#)`,
      ].join('\n'),
    )
  })

  it('gives a heading that occurs twice on a subpage the renderer’s second slug', async () => {
    const md = (await run(true, { text: { splitLevel: 2, numbering: false } })).root[0].markdown
    expect(md).toContain(`- [Remote Clients](source:${ID}@2.1#remote-clients|#)`)
    expect(md).toContain(`- [Remote Clients](source:${ID}@2.1#remote-clients-1|#)`)
  })

  it('names the subpages by each pattern, with numbering on and off', async () => {
    const names = async (subName: 'chapter' | 'title-chapter' | 'key-chapter' | 'key-number', numbering: boolean) =>
      titles((await run(true, { text: { subName, numbering } })).root[0].children)
    expect(await names('chapter', true)).toEqual(['1 Objective', '2 Network Access', 'Annex'])
    expect(await names('chapter', false)).toEqual(['Objective', 'Network Access', 'Annex'])
    expect(await names('title-chapter', true)).toEqual([
      'Network Guide – 1 Objective',
      'Network Guide – 2 Network Access',
      'Network Guide – Annex',
    ])
    expect(await names('title-chapter', false)).toEqual(['Network Guide – Objective', 'Network Guide – Network Access', 'Network Guide – Annex'])
    expect(await names('key-chapter', true)).toEqual(['net-guide – 1 Objective', 'net-guide – 2 Network Access', 'net-guide – Annex'])
    expect(await names('key-chapter', false)).toEqual(['net-guide – Objective', 'net-guide – Network Access', 'net-guide – Annex'])
    // The chapter number also without numbering; a heading without one takes its position.
    for (const numbering of [true, false]) {
      expect(await names('key-number', numbering)).toEqual(['net-guide.1 Objective', 'net-guide.2 Network Access', 'net-guide.3 Annex'])
    }
  })

  it('names the main page by file name or by an own ID from the space counter', async () => {
    expect((await run(true, { text: { mainName: 'file' } })).root[0].title).toBe('net-guide')
    const existingTitles = ['DOC-002', 'DOC-010 x', 'DOCX-050']
    const withId = await run(true, { text: { mainName: 'id', idPattern: 'DOC-###', subName: 'key-chapter' }, existingTitles })
    expect(withId.root[0].title).toBe('DOC-011 Network Guide')
    expect(withId.root[0].markdown.startsWith('# DOC-011 Network Guide\n')).toBe(true)
    expect(withId.root[0].children[0].title).toBe('DOC-011 – 1 Objective')
    const idOnly = await run(true, { text: { mainName: 'id', idPattern: 'DOC-###', idDisplay: 'id' }, existingTitles })
    expect(idOnly.root[0].title).toBe('DOC-011')
    expect(idOnly.root[0].markdown.startsWith('# Network Guide\n')).toBe(true)
  })

  it('numbers the files of one run in path order and keeps the number of a known page', async () => {
    const text = { mainName: 'id' as const, idPattern: 'DOC-###', idDisplay: 'id' as const }
    const two = await run(false, { text, existingTitles: ['DOC-010'] }, ['b.docx', 'a.docx'])
    expect(titles(two.root).sort()).toEqual(['DOC-011', 'DOC-012'])
    expect(two.root.find((n) => n.sourceRef.id === 'office:a.docx')!.title).toBe('DOC-011')
    const again = await run(false, {
      text,
      existingTitles: ['DOC-010', 'DOC-011', 'DOC-012'],
      existingIds: new Map([['office:a.docx', 'DOC-011']]),
    }, ['a.docx', 'c.docx'])
    expect(again.root.find((n) => n.sourceRef.id === 'office:a.docx')!.title).toBe('DOC-011')
    expect(again.root.find((n) => n.sourceRef.id === 'office:c.docx')!.title).toBe('DOC-013')
  })
})

describe('loadOfficeTree — document language', () => {
  // Invented German text, long enough to be detected.
  const GERMAN =
    'Dieses Handbuch beschreibt den Betrieb des Netzwerks an allen Standorten. Die Mitarbeiter finden hier die ' +
    'wichtigsten Regeln für den Zugang, die Pflege der Geräte und die Meldung von Störungen.'
  const docHtml =
    '<html><body>' +
    `<p>F451XTNetzhandbuch</p><p>${GERMAN}</p>` +
    '<h1>1Zugang</h1><p>Jede Abteilung ist verpflichtet, die Vorgaben einzuhalten.</p>' +
    '<h1>2Geräte</h1><p>Änderungen werden rechtzeitig mitgeteilt.</p>' +
    '</body></html>'
  const odt = zipSync({ 'content.xml': strToU8('<office:document-content/>') })
  const odp = zipSync({ 'content.xml': strToU8('<office:document-content/>') })
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8('<w:document><w:body/></w:document>'),
    'word/pad.bin': noise(500),
  })
  const pptx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'ppt/pad.bin': noise(500) })
  // Two untitled slides with hardly any text.
  const deckHtml = '<html><body><div><div><p>ok</p></div></div><div><div><p>x</p></div></div></body></html>'
  const conv: Converter = {
    async toHtml(_bytes, name) {
      return name.endsWith('.pptx')
        ? { html: deckHtml, media: new Map(), odf: odp, odfExt: 'odp' }
        : { html: docHtml, media: new Map(), odf: odt, odfExt: 'odt' }
    },
    async fromBundle() {
      throw new Error('not used')
    },
  }

  it('names the table of contents in the language of a German document, whatever the fallback', async () => {
    const tree = await loadOfficeTree(source({ 'netz.docx': docx }), { converter: conv, split: true, lang: 'en', limits: LIMITS })
    const [page] = tree.root
    expect(titles(page.children)).toEqual(['1 Zugang', '2 Geräte'])
    expect(page.markdown).toContain('\n## Inhalt\n')
    expect(page.markdown).not.toContain('## Contents')
  })

  it('falls back to the given language for an almost empty deck', async () => {
    const de = await loadOfficeTree(source({ 'tiny.pptx': pptx }), { converter: conv, split: true, lang: 'de', limits: LIMITS })
    expect(titles(de.root[0].children)).toEqual(['Folie 1', 'Folie 2'])
    const en = await loadOfficeTree(source({ 'tiny.pptx': pptx }), { converter: conv, split: true, limits: LIMITS })
    expect(titles(en.root[0].children)).toEqual(['Slide 1', 'Slide 2'])
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
    // The untitled slide's name follows the detected language of the deck.
    const slide3 = md.match(/## Folie 3/)![0]
    expect(section(md, slide3, '## Tabelle')).toContain('](_media/img-1.png)')
  })

  it('keeps the chart image with its data table and drops the table preview image', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: false, limits: LIMITS })
    const md = tree.root[0].markdown
    const zahlen = section(md, '## Zahlen', md.match(/## Folie 3/)![0])
    expect(zahlen).toContain('](_media/chart-1.svg)')
    expect(zahlen).toMatch(/^\|.*\|$/m)
    expect(zahlen).not.toContain('LibreOffice/')
    const tabelle = section(md, '## Tabelle')
    expect(tabelle).toMatch(/\| Name +\| Wert +\|/)
    expect(tabelle).not.toContain('chart-2.svg')
    expect(tree.root[0].media.map((m) => m.name).sort()).toEqual(['chart-1.svg', 'img-1.png'])
    expect(tree.mediaSkipped.filter((m) => m.name === 'chart data')).toEqual([])
  })

  it('splits into one page per slide', async () => {
    const tree = await loadOfficeTree(source(files), { converter: converter(), split: true, limits: LIMITS })
    const [page] = tree.root
    expect(page.markdown.trim()).toBe(`# ${page.title}`)
    const names = titles(page.children)
    expect([names[0], names[1], names[3]]).toEqual(['Agenda', 'Zahlen', 'Tabelle'])
    expect(names[2]).toMatch(/^Folie 3$/)
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
