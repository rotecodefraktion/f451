import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fromHtml } from 'hast-util-from-html'
import { InvalidSvgError, sanitizeSvg } from '../src/drafts/svg-sanitize.js'

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

function fixture(name: string): string {
  return readFileSync(`${fixturesDir}${name}`, 'utf8')
}

/**
 * `sanitizeSvg` (Plan Task 5): Whitelist-basiertes SVG-Sanitizing.
 * Sicherheitsfokus (Self-Review-Auflage aus dem Task-Brief): Groß-/
 * Kleinschreibung, verschachtelte Attribute, `javascript:`-Hrefs,
 * `foreignObject`, Entity-Tricks — jeweils mit einem eigenen Test, der
 * beweist, dass der Bypass NICHT funktioniert.
 */
describe('sanitizeSvg (Phase 2a Task 5)', () => {
  it('entfernt <script>, on*-Attribute und javascript:-Hrefs vollständig, behält harmlose Shapes', () => {
    const clean = sanitizeSvg(fixture('script.svg'))
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onload')
    expect(clean).not.toContain('onclick')
    expect(clean.toLowerCase()).not.toContain('javascript:')
    expect(clean).not.toContain("alert('böse')")
    // Die harmlose Kreis-Form (ohne das onclick) bleibt erhalten.
    expect(clean).toContain('<circle')
    expect(clean).toContain('cx="5"')
  })

  it('behält foreignObject (draw.io-Textumbruch), strippt aber on*-Attribute darin — auch bei Groß-/Kleinschreibung des Tags', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
      <FOREIGNOBJECT width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)">hi</div></FOREIGNOBJECT>
      <rect x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('<foreignObject')
    expect(clean).not.toContain('onload')
    // Der Textinhalt (das umbrechende draw.io-Label) bleibt erhalten.
    expect(clean).toContain('hi')
    expect(clean).toContain('<rect')
  })

  it('foreignObject: <script>/<iframe> darin werden SAMT Inhalt entfernt, Label-Markup (div/span/br) bleibt', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <switch>
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml" style="text-align:center">
            <span>Zeile eins</span><br>Zeile zwei
            <script>alert('xss')</script>
            <iframe src="https://evil.example"></iframe>
          </div>
        </foreignObject>
        <text x="0" y="0">Zeile eins Zeile…</text>
      </switch>
      <rect x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('<foreignObject')
    expect(clean).toContain('Zeile eins')
    expect(clean).toContain('Zeile zwei')
    expect(clean).toContain('<span')
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain("alert('xss')")
    expect(clean).not.toContain('iframe')
    expect(clean).not.toContain('evil.example')
    // Der einzeilige <text>-Fallback des <switch> bleibt unangetastet daneben.
    expect(clean).toContain('Zeile eins Zeile…')
  })

  it('foreignObject: xmlns auf dem HTML-Wrapper-div bleibt erhalten (nötig, damit der XML-Parser den Inhalt als XHTML rendert)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject>
      <rect x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('xmlns="http://www.w3.org/1999/xhtml"')
  })

  it('foreignObject: <br> wird XML-wohlgeformt serialisiert (Datei wird als image/svg+xml geparst)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">a<br>b</div></foreignObject>
      <rect x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    // to-html schließt im SVG-Space jedes Element explizit: `<br></br>` (oder
    // `<br/>`) ist wohlgeformtes XML — ein OFFENES `<br>` wäre der Fehler.
    expect(clean).toMatch(/<br\s*\/>|<br><\/br>/)
    expect(clean).not.toMatch(/<br>(?!<\/br>)/)
  })

  it('entfernt on*-Attribute UNABHÄNGIG von der Groß-/Kleinschreibung des Attributnamens', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle ONLOAD="alert(1)" OnClick="alert(2)" cx="1" cy="1" r="1"/></svg>`
    const clean = sanitizeSvg(svg)
    expect(clean.toLowerCase()).not.toContain('onload')
    expect(clean.toLowerCase()).not.toContain('onclick')
    expect(clean).toContain('<circle')
  })

  it('entfernt Skripte UNABHÄNGIG von der Verschachtelungstiefe', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g><g><g><script>alert(1)</script></g></g></g><rect x="0" y="0" width="1" height="1"/></svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('alert(1)')
    expect(clean).toContain('<rect')
  })

  it('löst HTML-Entity-Obfuskation eines javascript:-Hrefs auf und verwirft ihn (Parser dekodiert vor der Prüfung)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <use xlink:href="&#106;avascript&#58;alert(1)" x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean.toLowerCase()).not.toContain('javascript')
    expect(clean.toLowerCase()).not.toContain('alert(1)')
  })

  it('verwirft javascript:-Href auch bei ungewöhnlicher Groß-/Kleinschreibung und Whitespace', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <use xlink:href="Ja\tVaScRiPt:alert(1)" x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).not.toContain('alert(1)')
  })

  it('behält xlink:href-Fragment-Referenzen (#id) ohne Protokoll-Angabe (interne Referenz)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs><clipPath id="c1"><rect x="0" y="0" width="1" height="1"/></clipPath></defs>
      <use xlink:href="#c1" x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('xlink:href="#c1"')
  })

  it('verwirft entfernte http(s)-xlink:href auf <image> (Tracking-Pixel-Risiko), behält data:-URIs', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <image xlink:href="https://evil.example/pixel.png" x="0" y="0" width="1" height="1"/>
      <image xlink:href="data:image/png;base64,AAAA" x="0" y="0" width="1" height="1"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).not.toContain('evil.example')
    expect(clean).toContain('data:image/png;base64,AAAA')
  })

  it('behält id-Attribute UNGEPREFIXT (kein DOM-Clobbering-Schutz nötig, siehe Schema-Kommentar) — Gradient bleibt referenzierbar', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g1"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
      <rect x="0" y="0" width="1" height="1" fill="url(#g1)"/>
    </svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('id="g1"')
    expect(clean).toContain('fill="url(#g1)"')
  })

  it('verwirft ein style-Attribut mit eingebettetem javascript:-Aufruf (Defense-in-Depth, CSS-Injektion)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="1" height="1" style="background:url(javascript:alert(1))"/></svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).not.toContain('javascript')
    expect(clean).toContain('<rect')
  })

  it('entfernt ein <style>-Element mit eingebettetem javascript:-Aufruf komplett', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>.x{background:url(javascript:alert(1))}</style><rect x="0" y="0" width="1" height="1"/></svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).not.toContain('javascript')
    expect(clean).toContain('<rect')
  })

  it('behält harmlose <style>-Elemente (draw.io-CSS-Klassen)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><rect class="a" x="0" y="0" width="1" height="1"/></svg>`
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('.a{fill:red}')
  })

  it('draw.io-Fixture: content-Attribut (mxfile) und <metadata> bleiben mit identischem DEKODIERTEM Wert erhalten', () => {
    const original = fixture('drawio.svg')
    const clean = sanitizeSvg(original)

    // Der SERIALISIERTE Wert darf sich in der Entity-Schreibweise unter-
    // scheiden (z. B. `&quot;` vs. `&#x22;` — beides dekodiert zu `"`), muss
    // aber nach dem Dekodieren (erneutes Parsen, wie ein echter Browser/
    // draw.io es täte) exakt dem ursprünglichen `content`-Wert entsprechen —
    // sonst wäre das reimportierte mxfile-Payload verändert.
    const decodedContentOf = (svg: string): unknown => {
      const tree = fromHtml(svg, { fragment: true, space: 'svg' })
      const root = tree.children.find((n) => n.type === 'element' && n.tagName === 'svg')
      return root && root.type === 'element' ? root.properties.content : undefined
    }
    const originalContent = decodedContentOf(original)
    expect(originalContent).toBeTruthy()
    expect(decodedContentOf(clean)).toBe(originalContent)

    expect(clean).toContain('mxfile')
    expect(clean).toContain('<metadata')
    expect(clean).toContain('draw.io-Diagramm')
    expect(clean).toContain('<rect')
    expect(clean).toContain('Beispielknoten')
  })

  it('draw.io-Fixture: das serialisierte content-Attribut ist wohlgeformtes XML (kein rohes < oder > im Attributwert)', () => {
    const clean = sanitizeSvg(fixture('drawio.svg'))
    const match = /content="([^"]*)"/.exec(clean)
    expect(match).not.toBeNull()
    const rawValue = match![1]!
    expect(rawValue).not.toMatch(/</)
    expect(rawValue).not.toMatch(/>/)
  })

  it('wirft InvalidSvgError, wenn kein <svg>-Root gefunden wird', () => {
    expect(() => sanitizeSvg('<html><body>kein SVG</body></html>')).toThrow(InvalidSvgError)
    expect(() => sanitizeSvg('gar kein Markup')).toThrow(InvalidSvgError)
  })

  it('wirft InvalidSvgError, wenn nach dem Sanitizing nichts Sichtbares übrig bleibt', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    expect(() => sanitizeSvg(svg)).toThrow(InvalidSvgError)
  })
})

describe('Kommentar-Erhalt (Excalidraw-Payload, Phase 3e)', () => {
  it('erhält die Excalidraw-Payload-Kommentare byte-erkennbar', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
      + '<!-- svg-source:excalidraw --><!-- payload-type:application/vnd.excalidraw+json -->'
      + '<!-- payload-version:2 --><!-- payload-start -->eyJ2ZXJzaW9uIjoiMSJ9<!-- payload-end -->'
      + '<rect width="10" height="10"/></svg>'
    const out = sanitizeSvg(svg)
    expect(out).toContain('payload-type:application/vnd.excalidraw+json')
    expect(out).toContain('payload-start')
    expect(out).toContain('eyJ2ZXJzaW9uIjoiMSJ9')
    expect(out).toContain('payload-end')
  })
  it('Kommentare bleiben inert — kein Markup-Ausbruch, Skripte weiterhin gestrippt', () => {
    // Abweichung vom Brief-Testcode: `<img src=x onerror=...>` (ohne eigenen
    // Elternschluss) löst UNABHÄNGIG von Kommentaren/`allowComments` die
    // HTML5-Foreign-Content-„Breakout"-Regel aus (`img` steht auf der
    // Breakout-Taglist, siehe WHATWG-Parsing-Spec §13.2.6.5) — der Parser
    // verlässt daraufhin den SVG-Namespace, sodass das nachfolgende `<rect>`
    // zu einem GESCHWISTER von `<svg>` statt einem Kind wird und `sanitizeSvg`
    // (das nur das erste `<svg>`-Element als Root nimmt) es verwirft. Das ist
    // eine vorbestehende Parser-Eigenheit ohne Bezug zum eigentlichen Testziel
    // (Kommentar-Inertheit) — mit `<rect onerror=…/>` (selbstschließend, kein
    // Breakout-Tag) bleibt die sicherheitsrelevante Aussage (on*-Attribut wird
    // trotz verdächtiger Kommentar-Umgebung gestrippt) erhalten.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">'
      + '<!--><script>alert(1)</script>-->'
      + '<!-- --><rect onerror="alert(2)" width="1" height="1"/> -->'
      + '<rect width="1" height="1"/></svg>'
    const out = sanitizeSvg(svg)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).toContain('<rect')
  })
  it('draw.io content-Attribut übersteht weiterhin (Regression)', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;&lt;diagram&gt;x&lt;/diagram&gt;&lt;/mxfile&gt;">'
      + '<rect width="1" height="1"/></svg>'
    const out = sanitizeSvg(svg)
    expect(out).toContain('mxfile')
  })
})
