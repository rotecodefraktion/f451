import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { acceptOdfContent, acceptOoxmlPart, acceptTrackedChanges } from './revisions.js'

const R = (t: string): string => `<w:r><w:t>${t}</w:t></w:r>`
const DEL = (t: string): string => `<w:del w:id="1" w:author="A"><w:r><w:delText>${t}</w:delText></w:r></w:del>`
const INS = (inner: string): string => `<w:ins w:id="2" w:author="A">${inner}</w:ins>`
const body = (inner: string): string => `<w:document><w:body>${inner}</w:body></w:document>`
const text = (xml: string): string => [...xml.matchAll(/<w:t>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('|')

describe('acceptOoxmlPart', () => {
  it('drops deleted text and keeps inserted text', () => {
    const out = acceptOoxmlPart(body(`<w:p>${R('Status: ')}${DEL('Final')}${INS(R('in progress'))}</w:p>`))
    expect(text(out.xml)).toBe('Status: |in progress')
    expect(out.xml).not.toContain('Final')
    expect(out.xml).not.toContain('w:ins')
    expect(out.changes).toBe(2)
  })

  it('drops text that was inserted and deleted again', () => {
    const out = acceptOoxmlPart(body(`<w:p>${R('Keep')}${INS(DEL('gone'))}</w:p>`))
    expect(text(out.xml)).toBe('Keep')
    expect(out.xml).not.toContain('gone')
  })

  it('joins a paragraph whose mark was deleted with the next one, keeping the later properties', () => {
    const p1 = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:del w:id="3" w:author="A"/></w:rPr></w:pPr>${R('First ')}</w:p>`
    const p2 = `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${R('second')}</w:p>`
    const out = acceptOoxmlPart(body(p1 + p2))
    expect(out.xml.match(/<w:p>/g)).toHaveLength(1)
    expect(out.xml).toContain('<w:pStyle w:val="Normal"/>')
    expect(out.xml).not.toContain('Heading1')
    expect(text(out.xml)).toBe('First |second')
  })

  it('removes a deleted table row and the old formatting of changed properties', () => {
    const row = (t: string, del = false): string =>
      `<w:tr>${del ? '<w:trPr><w:del w:id="4" w:author="A"/></w:trPr>' : ''}<w:tc><w:p>${R(t)}</w:p></w:tc></w:tr>`
    const pPr = '<w:pPr><w:pStyle w:val="Heading2"/><w:pPrChange w:id="5"><w:pPr><w:pStyle w:val="Heading5"/></w:pPr></w:pPrChange></w:pPr>'
    const out = acceptOoxmlPart(body(`<w:tbl>${row('a')}${row('old', true)}${row('b')}</w:tbl><w:p>${pPr}${R('H')}</w:p>`))
    expect(text(out.xml)).toBe('a|b|H')
    expect(out.xml).not.toContain('Heading5')
    expect(out.xml).toContain('Heading2')
  })

  it('leaves a part without revisions as it is', () => {
    const xml = body(`<w:p>${R('Plain')}</w:p>`)
    expect(acceptOoxmlPart(xml)).toEqual({ xml, changes: 0 })
  })
})

describe('acceptOdfContent', () => {
  it('removes the change regions and marks; the body already reads as accepted', () => {
    const xml =
      '<office:text><text:tracked-changes><text:changed-region text:id="c1"><text:deletion><text:p>old</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
      '<text:p>A<text:change text:change-id="c1"/>B<text:change-start text:change-id="c2"/>new<text:change-end text:change-id="c2"/></text:p></office:text>'
    const out = acceptOdfContent(xml)
    expect(out.xml).toBe('<office:text><text:p>ABnew</text:p></office:text>')
    expect(out.changes).toBe(2)
  })
})

describe('acceptTrackedChanges', () => {
  it('rewrites the Word parts of a .docx and keeps the other entries', () => {
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(body(`<w:p>${DEL('x')}${R('y')}</w:p>`)),
      'word/footnotes.xml': strToU8(`<w:footnotes><w:p>${INS(R('n'))}</w:p></w:footnotes>`),
      'word/media/a.png': new Uint8Array([1, 2, 3]),
    })
    const out = acceptTrackedChanges(docx, 'docx')
    expect(out.changes).toBe(2)
    const files = unzipSync(out.bytes)
    expect(text(strFromU8(files['word/document.xml']))).toBe('y')
    expect(strFromU8(files['word/footnotes.xml'])).not.toContain('w:ins')
    expect([...files['word/media/a.png']]).toEqual([1, 2, 3])
  })

  it('returns the bytes unchanged for other formats, packages without revisions and broken ZIPs', () => {
    const plain = zipSync({ 'word/document.xml': strToU8(body(`<w:p>${R('y')}</w:p>`)) })
    expect(acceptTrackedChanges(plain, 'docx').bytes).toBe(plain)
    expect(acceptTrackedChanges(plain, 'pptx').bytes).toBe(plain)
    const broken = new Uint8Array([1, 2, 3])
    expect(acceptTrackedChanges(broken, 'docx')).toEqual({ bytes: broken, changes: 0 })
  })

  it('keeps mimetype as the first entry of an ODF package', () => {
    const odt = zipSync({
      mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
      'content.xml': strToU8('<text:p>A<text:change text:change-id="c1"/></text:p>'),
    })
    const out = acceptTrackedChanges(odt, 'odt')
    expect(Object.keys(unzipSync(out.bytes))[0]).toBe('mimetype')
  })
})
