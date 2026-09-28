import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render.js'

const resolve = {
  resolveLink: (t: string) =>
    t.includes('fehlt') ? null : { href: `/pages/id-${t.replaceAll('/', '_')}` },
}

describe('renderHtml', () => {
  it('rendert GFM (Tabelle, Tasklist, Codeblock mit Sprachklasse) mit Heading-IDs', () => {
    const html = renderHtml(
      '## Abschnitt Eins\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] erledigt\n\n```ts\nconst x = 1\n```\n',
      resolve,
    )
    expect(html).toContain('<h2 id="abschnitt-eins">')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<code class="language-ts">')
  })

  it('löst Wikilinks und relative Links über den Callback auf', () => {
    const html = renderHtml('[[betrieb/monitoring]] und [Runbook](../runbooks/index.md)', resolve)
    expect(html).toContain('<a href="/pages/id-betrieb_monitoring">betrieb/monitoring</a>')
    expect(html).toContain('<a href="/pages/id-.._runbooks_index.md">Runbook</a>')
  })

  it('markiert nicht auflösbare interne Links als broken-link (kein href)', () => {
    const html = renderHtml('[[fehlt/seite]]', resolve)
    expect(html).toContain('class="broken-link"')
    expect(html).not.toContain('href')
  })

  it('lässt externe Links unangetastet, ergänzt rel-Schutz', () => {
    const html = renderHtml('[ext](https://example.com)', resolve)
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('schreibt Bildpfade über resolveImage um', () => {
    const html = renderHtml('![d](_media/arch.drawio.svg)', {
      ...resolve,
      resolveImage: (s) => `/media/8f3ka2/${s.replace('_media/', '')}`,
    })
    expect(html).toContain('<img src="/media/8f3ka2/arch.drawio.svg" alt="d"')
  })

  it('Obsidian-Bildbreite `![Alt|400](url)` → width-Attribut, Alt bereinigt, resolveImage greift', () => {
    const html = renderHtml('![Programmablauf|400](_media/pa.drawio.svg)', {
      ...resolve,
      resolveImage: (s) => `/media/8f3ka2/${s.replace('_media/', '')}`,
    })
    expect(html).toContain('src="/media/8f3ka2/pa.drawio.svg"')
    expect(html).toContain('width="400"')
    expect(html).toContain('alt="Programmablauf"')
    expect(html).not.toContain('alt="Programmablauf|400"')
  })

  it('Obsidian-Bildgröße `![Alt|400x300](url)` → width + height', () => {
    const html = renderHtml('![d|400x300](_media/x.svg)', resolve)
    expect(html).toContain('width="400"')
    expect(html).toContain('height="300"')
  })

  it('Bild ohne Größen-Suffix bleibt unverändert (kein width, Alt intakt)', () => {
    const html = renderHtml('![ganz normal](_media/x.svg)', resolve)
    expect(html).toContain('alt="ganz normal"')
    expect(html).not.toContain('width=')
  })

  it('Frontmatter erscheint nicht im HTML', () => {
    const html = renderHtml('---\ntitle: X\n---\n\ntext', resolve)
    expect(html).not.toContain('title: X')
    expect(html).toContain('<p>text</p>')
  })

  it('doppelte Headings bekommen eindeutige HTML-IDs (id="setup" + id="setup-1")', () => {
    const html = renderHtml('## Setup\n\ntext\n\n## Setup\n\nmehr text', resolve)
    expect(html).toContain('id="setup"')
    expect(html).toContain('id="setup-1"')
  })

  it('Umlaute im Heading bleiben in der HTML-ID erhalten', () => {
    const html = renderHtml('## Größe ändern', resolve)
    expect(html).toContain('id="größe-ändern"')
  })

  it('YouTube-URL allein auf einer Zeile → Thumbnail-Embed-Markup (kein iframe)', () => {
    const html = renderHtml('https://www.youtube.com/watch?v=dQw4w9WgXcQ\n', { resolveLink: () => null })
    expect(html).toContain('class="yt-embed"')
    expect(html).toContain('data-video-id="dQw4w9WgXcQ"')
    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
    expect(html).toContain('i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(html).toContain('Video abspielen (YouTube)')
    expect(html).not.toContain('<iframe')
    // Fix-Runde 1: die className-Attribute müssen die Sanitisierung überstehen.
    // defaultSchema.attributes.a enthält bereits einen ['className', ...]-Eintrag
    // (Footnote-Backref); hast-util-sanitize nimmt pro Property-Namen nur den
    // ERSTEN Eintrag der Liste. Ein einfach angehängter zweiter className-Eintrag
    // würde nie greifen -> a.yt-link bliebe class="" (Task-3-Klick-Handler tot).
    expect(html).toContain('class="yt-link"')
    expect(html).toContain('class="yt-thumb"')
    expect(html).toContain('class="yt-play"')
  })

  it('YouTube-URL im Satz bleibt normaler Link (kein Embed)', () => {
    const html = renderHtml('Siehe https://www.youtube.com/watch?v=dQw4w9WgXcQ dazu.\n', { resolveLink: () => null })
    expect(html).not.toContain('yt-embed')
    expect(html).toContain('<a')
  })

  it('YouTube-URL allein in einer Listenzeile → Embed innerhalb <li> (kein Top-Level-Only)', () => {
    // remarkYoutubeEmbeds nutzt unist-util-visit ohne Tiefenbeschränkung: "URL
    // allein auf einer Zeile" gilt bewusst unabhängig vom Kontext (Liste,
    // Blockquote, Alert) — ein Embed dort ist gültiger Flow-Content.
    const html = renderHtml('- https://youtu.be/dQw4w9WgXcQ\n', { resolveLink: () => null })
    expect(html).toContain('<li>')
    expect(html).toContain('class="yt-embed"')
    expect(html).toContain('data-video-id="dQw4w9WgXcQ"')
  })

  it('XSS: yt-Markup übersteht die Sanitisierung nur mit exakten Klassen/Attributen', () => {
    // Handgeschriebenes Roh-HTML, das die freigegebenen Klassen missbraucht,
    // wird vom Sanitizer entschärft: fremde Attribute/Tags fliegen raus.
    const html = renderHtml('<div class="yt-embed" data-video-id="x" onclick="alert(1)"><iframe src="javascript:alert(1)"></iframe></div>\n', { resolveLink: () => null })
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<iframe')
  })
})
