import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildHtmlBundle, renderExportHtml } from './bundle.js'
import { context, node, page, pngHeader } from './test-helpers.js'

const roots = [node('start', 'Start', [node('child', 'Child', [node('grand', 'Grand')])]), node('other', 'Other')]
const ctx = context(roots)

describe('renderExportHtml', () => {
  it('starts each page with its title and shifts headings by depth, capped at H6', () => {
    const { html } = renderExportHtml(
      [
        page('start', 'Start', 0, '# Start\n\n## Intro\n\ntext'),
        page('child', 'Child', 1, '## Part\n\n##### Deep'),
        page('grand', 'Grand', 5, '## Low'),
      ],
      ctx,
    )
    expect(html).toContain('<h1 id="p-start">Start</h1>')
    // The lead `# Start` repeating the title is dropped.
    expect(html.match(/>Start<\/h1>/g)).toHaveLength(1)
    expect(html).toContain('<h2 id="p-start-intro">Intro</h2>')
    expect(html).toContain('<h2 id="p-child">Child</h2>')
    expect(html).toContain('<h3 id="p-child-part">Part</h3>')
    expect(html).toContain('<h6 id="p-child-deep">Deep</h6>')
    expect(html).toContain('<h6 id="p-grand">Grand</h6>')
    expect(html).toContain('<h6 id="p-grand-low">Low</h6>')
  })

  it('writes footnotes in LibreOffice markup, numbered across the document', () => {
    const { html } = renderExportHtml(
      [
        page('start', 'Start', 0, 'One[^a] and again[^a].\n\n[^a]: First note'),
        page('child', 'Child', 1, 'Two[^1].\n\n[^1]: Second note'),
      ],
      ctx,
    )
    expect(html).toContain('<a class="sdfootnoteanc" name="sdfootnote1anc" href="#sdfootnote1sym"><sup>1</sup></a>')
    expect(html).toContain('<a class="sdfootnoteanc" name="sdfootnote2anc" href="#sdfootnote2sym"><sup>2</sup></a>')
    expect(html).toContain(
      '<div id="sdfootnote1"><p class="sdfootnote"><a class="sdfootnotesym" name="sdfootnote1sym" href="#sdfootnote1anc">1</a>\u00a0First note</p></div>',
    )
    expect(html).toContain('<div id="sdfootnote2"><p class="sdfootnote">')
    // A second reference to the same note repeats its number only.
    expect(html).toContain('again<sup>1</sup>')
    expect(html).not.toContain('data-footnotes')
    expect(html).not.toContain('data-footnote-backref')
    // Footnote bodies come after all pages.
    expect(html.indexOf('id="sdfootnote1"')).toBeGreaterThan(html.indexOf('Two'))
  })

  it('turns alerts into a bordered one-cell table with the label in bold', () => {
    const { html } = renderExportHtml([page('start', 'Start', 0, '> [!WARNING]\n> Careful here')], ctx)
    expect(html).toContain('<table border="1" cellpadding="6" cellspacing="0" width="100%">')
    expect(html).toContain('<td><p><strong>Warning</strong></p><p>Careful here</p></td>')
    expect(html).not.toContain('alert')
  })

  it('links pages of the export in-document and other pages absolutely', () => {
    const { html } = renderExportHtml(
      [
        page('start', 'Start', 0, 'See [[Child#Part]], [[Other]], [x](https://example.org/x) and [up](#intro).'),
        page('child', 'Child', 1, 'Back to [[Start]]. Gone: [[Nowhere]].'),
      ],
      ctx,
    )
    expect(html).toContain('href="#p-child-part"')
    expect(html).toContain('href="https://wiki.example/wiki/space/other"')
    expect(html).toContain('href="https://example.org/x"')
    expect(html).toContain('href="#p-start-intro"')
    expect(html).toContain('href="#p-start"')
    expect(html).toContain('Gone: Nowhere.')
    expect(html).not.toContain('broken-link')
  })

  it('collects images per page under distinct names and links other attachments', () => {
    const a = pngHeader(10, 10, 1)
    const b = pngHeader(10, 10, 2)
    const zip = buildHtmlBundle(
      [
        page('start', 'Start', 0, '![one](_media/pic.png)\n\n[spec](_media/spec.pdf)\n\n![gone](_media/missing.png)', { 'pic.png': a }),
        page('child', 'Child', 1, '![two](./_media/pic.png)', { 'pic.png': b }),
      ],
      ctx,
    )
    const files = unzipSync(zip)
    const html = strFromU8(files['document.html']!)
    // Writer embeds only `data:` images, so each page's image is inlined.
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
    expect(html).toContain(`<img src="data:image/png;base64,${b64(a)}" alt="one" width="10" height="10">`)
    expect(html).toContain(`<img src="data:image/png;base64,${b64(b)}" alt="two" width="10" height="10">`)
    expect(Object.keys(files)).toEqual(['document.html'])
    expect(html).toContain('href="https://wiki.example/media/start/spec.pdf?ref=main"')
    expect(html).not.toContain('_media/missing.png')
    expect(html).toContain('gone')
  })

  it('gives images their natural size, capped at the text width, and tables a border', () => {
    const wide = pngHeader(1200, 300, 3)
    const { html } = renderExportHtml(
      [page('start', 'Start', 0, '![wide](_media/wide.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |', { 'wide.png': wide })],
      ctx,
    )
    expect(html).toMatch(/<img src="media\/p-start-wide\.png" alt="wide" width="600" height="150">/)
    expect(html).toMatch(/<table border="1" cellpadding="4" cellspacing="0">/)
  })

  it('leaves Mermaid code blocks as code', () => {
    const { html } = renderExportHtml([page('start', 'Start', 0, '```mermaid\ngraph TD; A-->B\n```')], ctx)
    expect(html).toMatch(/<pre[^>]*><code class="language-mermaid">graph TD; A--/)
  })
})
