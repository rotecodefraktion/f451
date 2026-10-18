import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { markOdf, markOoxml, markPackage } from './marks.js'
import { acceptPackageChanges, rewritePackage } from './revisions.js'

const STYLES =
  '<w:styles>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/><w:basedOn w:val="Standard"/></w:style>' +
  '<w:style w:type="character" w:styleId="TitelZchn"><w:name w:val="Title Char"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Ueberschrift2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Ueberschrift7"><w:name w:val="heading 7"/><w:basedOn w:val="Standard"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Tief"><w:name w:val="Deep Custom"/><w:basedOn w:val="Ueberschrift7"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Ebene8"><w:name w:val="Level Eight"/><w:pPr><w:outlineLvl w:val="7"/></w:pPr></w:style>' +
  '</w:styles>'

function p(style: string | null, text: string, extraPPr = ''): string {
  const pStyle = style ? `<w:pStyle w:val="${style}"/>` : ''
  const pPr = pStyle || extraPPr ? `<w:pPr>${pStyle}${extraPPr}</w:pPr>` : ''
  return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`
}

function doc(...paragraphs: string[]): string {
  return `<w:document><w:body>${paragraphs.join('')}</w:body></w:document>`
}

/** Text of each paragraph, tokens included. */
function texts(xml: string): string[] {
  return [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''))
}

describe('markOoxml', () => {
  it('marks the first Title paragraph by its style name, after the paragraph properties', () => {
    const out = markOoxml(
      doc('<w:p><w:pPr><w:pStyle w:val="Titel"/></w:pPr></w:p>', p('Titel', 'Sample Title'), p('Titel', 'Second title'), p(null, 'Body')),
      STYLES,
    )
    expect(out.marked).toBe(1)
    expect(out.xml).toContain('<w:pPr><w:pStyle w:val="Titel"/></w:pPr><w:r><w:t>F451XT</w:t></w:r><w:r><w:t>Sample Title</w:t></w:r>')
    expect(texts(out.xml)).toEqual(['', 'F451XTSample Title', 'Second title', 'Body'])
  })

  it('marks outline levels 7–9 by style name, style chain and own outline level', () => {
    const out = markOoxml(
      doc(
        p('Ueberschrift2', 'Level two'),
        p('Ueberschrift7', 'By name'),
        p('Tief', 'Through basedOn'),
        p('Ebene8', 'By style outline'),
        p(null, 'Own outline', '<w:outlineLvl w:val="8"/>'),
        p('Ueberschrift7', 'Body text override', '<w:outlineLvl w:val="9"/>'),
        p(null, 'Plain'),
      ),
      STYLES,
    )
    expect(texts(out.xml)).toEqual([
      'Level two',
      'F451XL7XBy name',
      'F451XL7XThrough basedOn',
      'F451XL8XBy style outline',
      'F451XL9XOwn outline',
      'Body text override',
      'Plain',
    ])
    expect(out.marked).toBe(4)
  })

  it('leaves a document without styles or marks unchanged', () => {
    const xml = doc(p(null, 'Only text'))
    expect(markOoxml(xml, null)).toEqual({ xml, marked: 0 })
    expect(markOoxml(xml, STYLES)).toEqual({ xml, marked: 0 })
  })
})

describe('markOdf', () => {
  const content = (body: string): string =>
    '<office:document-content><office:automatic-styles>' +
    '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Title"/>' +
    '<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Text_20_body"/>' +
    `</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`

  it('marks the first paragraph in the Title style or one derived from it', () => {
    const direct = markOdf(content('<text:p text:style-name="Title">Plain Title</text:p><text:p text:style-name="Title">Again</text:p>'))
    expect(direct.xml).toContain('<text:p text:style-name="Title">F451XTPlain Title</text:p><text:p text:style-name="Title">Again</text:p>')
    const derived = markOdf(content('<text:p text:style-name="P1"/><text:p text:style-name="P2">Body</text:p><text:p text:style-name="P1">Derived <text:span>Title</text:span></text:p>'))
    expect(derived.marked).toBe(1)
    expect(derived.xml).toContain('<text:p text:style-name="P1">F451XTDerived <text:span>Title</text:span></text:p>')
    expect(derived.xml).toContain('<text:p text:style-name="P2">Body</text:p>')
  })

  it('marks headings with outline level 7 and deeper', () => {
    const out = markOdf(
      content(
        '<text:h text:style-name="Heading_20_3" text:outline-level="3">Three</text:h>' +
          '<text:h text:style-name="Heading_20_7" text:outline-level="7">Seven</text:h>' +
          '<text:h text:outline-level="9">Nine</text:h>',
      ),
    )
    expect(out.marked).toBe(2)
    expect(out.xml).toContain('text:outline-level="3">Three</text:h>')
    expect(out.xml).toContain('text:outline-level="7">F451XL7XSeven</text:h>')
    expect(out.xml).toContain('text:outline-level="9">F451XL9XNine</text:h>')
  })
})

describe('markPackage with rewritePackage', () => {
  const pass = (bytes: Uint8Array, ext: string): Uint8Array =>
    rewritePackage(bytes, ext, (files, kind) => acceptPackageChanges(files, kind) + markPackage(files, kind) > 0)

  it('marks word/document.xml in the same pass that accepts tracked changes', () => {
    const docx = zipSync({
      'word/styles.xml': strToU8(STYLES),
      'word/document.xml': strToU8(doc(p('Titel', 'Sample Title'), '<w:p><w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>')),
    })
    const xml = strFromU8(unzipSync(pass(docx, 'docx'))['word/document.xml'])
    expect(texts(xml)).toEqual(['F451XTSample Title', 'kept'])
    expect(xml).not.toContain('gone')
  })

  it('returns the input itself when nothing is marked or the format has no package pass', () => {
    const plain = zipSync({ 'word/document.xml': strToU8(doc(p(null, 'Text'))) })
    expect(pass(plain, 'docx')).toBe(plain)
    expect(pass(plain, 'pptx')).toBe(plain)
  })
})
