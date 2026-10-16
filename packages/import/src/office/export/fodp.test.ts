import { describe, expect, it } from 'vitest'
import { pixelSize, renderFodp } from './fodp.js'
import { context, node, page, pngHeader, wellFormedRoot } from './test-helpers.js'
import { base64 } from './xml.js'

const roots = [node('start', 'Start', [node('child', 'Child')]), node('other', 'Other')]
const ctx = context(roots)

/** [slide name, title] per `draw:page`. */
function slides(xml: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const m of xml.matchAll(/<draw:page draw:name="([^"]*)"[^>]*><draw:frame presentation:style-name="Default-title"[^>]*><draw:text-box><text:p>([^<]*)<\/text:p>/g)) {
    out.push([m[1]!, m[2]!])
  }
  return out
}

function slideXml(xml: string, name: string): string {
  const start = xml.indexOf(`<draw:page draw:name="${name}"`)
  return xml.slice(start, xml.indexOf('</draw:page>', start))
}

describe('renderFodp', () => {
  it('makes a title slide, a slide per ## section and section slides for subpages', () => {
    const { xml } = renderFodp(
      [
        page('start', 'Start', 0, '# Start\n\nIntro text\n\n## Agenda\n\nPoints\n\n## Empty\n\n## Numbers\n\nMore'),
        page('child', 'Child', 1, '## Child part\n\nBody'),
      ],
      ctx,
    )
    expect(wellFormedRoot(xml)).toBe('office:document')
    expect(xml).toContain('office:mimetype="application/vnd.oasis.opendocument.presentation"')
    expect(xml).toContain('fo:page-width="28cm" fo:page-height="15.75cm"')
    expect(slides(xml)).toEqual([
      ['p-start', 'Start'],
      ['p-start-1', 'Start'],
      ['p-start-2', 'Agenda'],
      ['p-start-4', 'Numbers'],
      ['p-child', 'Child'],
      ['p-child-2', 'Child part'],
    ])
    expect(slideXml(xml, 'p-start-1')).toContain('Intro text')
  })

  it('writes lists with levels and headings below ## as bold paragraphs', () => {
    const { xml } = renderFodp([page('start', 'Start', 0, '## S\n\n### Sub\n\n- a\n  - b\n    - c\n- d\n\n1. one\n2. two')], ctx)
    const s = slideXml(xml, 'p-start-2')
    expect(s).toContain('<text:span text:style-name="T-b">Sub</text:span>')
    expect(s).toMatch(
      /<text:list text:style-name="L-bullet"><text:list-item><text:p[^>]*>a<\/text:p><text:list text:style-name="L-bullet"><text:list-item><text:p[^>]*>b<\/text:p><text:list/,
    )
    expect(s).toContain('<text:list text:style-name="L-num">')
    expect(xml).toContain('<text:list-style style:name="L-bullet">')
  })

  it('moves the speaker notes block into the slide notes', () => {
    const md = '## Agenda\n\nVisible\n\n> [!NOTE]\n> **Speaker notes**\n>\n> Keep it short.'
    const { xml } = renderFodp([page('start', 'Start', 0, md)], ctx)
    const s = slideXml(xml, 'p-start-2')
    const notesAt = s.indexOf('<presentation:notes')
    expect(notesAt).toBeGreaterThan(0)
    expect(s.slice(notesAt)).toContain('Keep it short.')
    expect(s.slice(0, notesAt)).not.toContain('Keep it short.')
    expect(s).not.toContain('Speaker notes')
  })

  it('keeps other alerts on the slide with their label', () => {
    const { xml } = renderFodp([page('start', 'Start', 0, '## S\n\n> [!TIP]\n> Try this')], ctx)
    const s = slideXml(xml, 'p-start-2')
    expect(s).toContain('>Tip</text:span>')
    expect(s).toContain('Try this')
    expect(s).not.toContain('<presentation:notes')
  })

  it('writes tables as table:table in a frame with a bold header', () => {
    const { xml } = renderFodp([page('start', 'Start', 0, '## T\n\n| A | B |\n|---|---|\n| 1 | 2 |')], ctx)
    const s = slideXml(xml, 'p-start-2')
    expect(s).toMatch(/<draw:frame[^>]*><table:table[^>]*><table:table-column[^>]*\/><table:table-column[^>]*\/><table:table-row>/)
    expect(s).toContain('<text:span text:style-name="T-b">A</text:span>')
    expect(s).toContain('<text:p text:style-name="P-cell">2</text:p>')
    expect(wellFormedRoot(xml)).toBe('office:document')
  })

  it('embeds images as binary data, scaled into the content area', () => {
    const png = pngHeader(1920, 1080)
    const { xml } = renderFodp([page('start', 'Start', 0, '## I\n\n![Chart](_media/chart.png)', { 'chart.png': png })], ctx)
    const s = slideXml(xml, 'p-start-2')
    expect(s).toContain(`<draw:image><office:binary-data>${base64(png)}</office:binary-data></draw:image>`)
    expect(s).toContain('<svg:title>Chart</svg:title>')
    const width = Number(/<draw:frame draw:style-name="gr-image"[^>]*svg:width="([\d.]+)cm"/.exec(s)?.[1])
    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThanOrEqual(25)
  })

  it('links in-export pages to their slide and others absolutely; escapes text', () => {
    const { xml } = renderFodp(
      [page('start', 'Start', 0, '## L\n\n[[Child]], [[Other]] & <b>"x"</b>'), page('child', 'Child', 1, 'c')],
      ctx,
    )
    expect(xml).toContain('xlink:href="#p-child"')
    expect(xml).toContain('xlink:href="https://wiki.example/wiki/space/other"')
    expect(xml).toContain('&amp;')
    expect(wellFormedRoot(xml)).toBe('office:document')
  })

  it('reports slides with more than 12 lines', () => {
    const many = Array.from({ length: 13 }, (_, i) => `Line ${i}`).join('\n\n')
    const { overfullSlides } = renderFodp([page('start', 'Start', 0, `## Full\n\n${many}\n\n## Short\n\nok`)], ctx)
    expect(overfullSlides).toEqual(['Full'])
  })
})

describe('pixelSize', () => {
  it('reads PNG and SVG sizes', () => {
    expect(pixelSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 })
    expect(pixelSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>'))).toEqual({ width: 200, height: 100 })
    expect(pixelSize(new TextEncoder().encode('<svg viewBox="0 0 30 15"></svg>'))).toEqual({ width: 30, height: 15 })
    expect(pixelSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
