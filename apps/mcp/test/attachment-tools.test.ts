import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAttachmentTools } from '../src/tools/attachments.js'
import { authExtra, bodyOf, callOf, fakeServer, mockFetch, respond, textOf } from './naht.js'

/**
 * Anhänge über den MCP (`2026-07-27-mcp-anhaenge-design.md`).
 *
 * Geprüft wird an der bestehenden Naht (s. `naht.ts`): echte Tools, echter
 * Handler, echter HTTP-Client — nur der Netzzugriff ist ersetzt. Der Generator
 * bekommt ausdrücklich KEINE eigene Naht: Ihn getrennt zu prüfen läse sich
 * hübscher, ließe aber genau den Fall durch, der am wahrscheinlichsten ist —
 * der Generator stimmt, das Werkzeug ruft ihn falsch auf.
 */

function tools() {
  const { server, handlers } = fakeServer()
  registerAttachmentTools(server as never)
  return handlers
}

const bahnenSpec = {
  kind: 'swimlane' as const,
  lanes: ['Fachbereich', 'Betrieb'],
  steps: [
    { id: 's1', label: 'Antrag stellen', lane: 0, kind: 'terminal' as const },
    { id: 's2', label: 'Prüfen', lane: 1 },
    { id: 's3', label: 'Freigeben', lane: 0 },
  ],
  edges: [
    { from: 's1', to: 's2' },
    { from: 's2', to: 's3', label: 'ja' },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('save_diagram', () => {
  it('legt das erzeugte Diagramm über die JSON-Route im Entwurf ab', async () => {
    const spy = mockFetch([respond(200, { path: '_media/ablauf.drawio.svg' })])
    await tools().get('save_diagram')!({ id: 'p-1', name: 'ablauf', diagram: bahnenSpec }, authExtra)

    expect(spy).toHaveBeenCalledTimes(1)
    const { url, init } = callOf(spy)
    expect(url.pathname).toBe('/api/pages/p-1/draft/diagram')
    expect(init.method).toBe('PUT')
    // Der Pfad bekommt die Endung, die die Route verlangt — der Agent muss sie
    // nicht kennen.
    expect(bodyOf(spy).path).toBe('_media/ablauf.drawio.svg')
  })

  it('erzeugt ein SVG, das Zeichnung und mxGraph-XML deckungsgleich trägt', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!({ id: 'p-1', name: 'ablauf', diagram: bahnenSpec }, authExtra)
    const svg = bodyOf(spy).content as string

    // Das eingebettete mxGraph-XML — daran hängt die Bearbeitbarkeit im Editor.
    expect(svg).toContain('content="')
    expect(svg).toContain('&lt;mxfile')
    expect(svg).toContain('mxGraphModel')
    expect(svg).toContain('swimlane;html=1;horizontal=0;startSize=26')
    for (const id of ['s1', 's2', 's3']) expect(svg).toContain(`id=&quot;${id}&quot;`)

    // Der eigentliche Punkt: Jeder Schritt steht in BEIDEN Fassungen an
    // derselben Stelle — als Zelle im XML und als Kasten in der Zeichnung.
    // Läuft eines dem anderen davon, sieht das Diagramm im Editor anders aus
    // als in der Leseansicht, und niemand merkt es beim Speichern.
    // Ganzzahlige Geometrie: Die Zahlen landen in der mxGeometry, und die
    // sieht ein Mensch im Editor wieder.
    for (const [x, y] of [
      ['36', '89'],
      ['221', '314'],
      ['406', '89'],
    ]) {
      expect(svg, `XML ${x}/${y}`).toContain(`x=&quot;${x}&quot; y=&quot;${y}&quot; width=&quot;150&quot;`)
      expect(svg, `Zeichnung ${x}/${y}`).toContain(`<rect x="${x}" y="${y}" width="150"`)
    }
  })

  it('zeichnet im Hausstil der Vorlagen', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!({ id: 'p-1', name: 'ablauf', diagram: bahnenSpec }, authExtra)
    const svg = bodyOf(spy).content as string

    expect(svg).toContain('#e50c2e') // Schritt
    expect(svg).toContain('#8d0981') // Anfang/Ende
    expect(svg).toContain('#ffffff') // Beschriftung
    expect(svg).toContain('Helvetica')
    // Die Bahnfläche ist der eine Wert, der sich zwischen den Modi
    // unterscheidet — und ohne die color-scheme-Deklaration bliebe die
    // Zwei-Modi-Schreibweise wirkungslos (gemessen 2026-07-27).
    expect(svg).toContain('light-dark(#e9e9e9,#1a1a1a)')
    expect(svg).toContain('style="color-scheme: light dark"')
  })

  it('rechnet die waagerechte Lage der Schritte aus der Prozessreihenfolge', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!({ id: 'p-1', name: 'ablauf', diagram: bahnenSpec }, authExtra)
    const svg = bodyOf(spy).content as string

    // Kopfbreite 26 + 10 Luft, dann Rasterabstand 185 — unabhängig davon, in
    // welcher Bahn ein Schritt liegt. Der Agent nennt keine Koordinaten.
    expect(svg).toContain('x="36"')
    expect(svg).toContain('x="221"')
    expect(svg).toContain('x="406"')
  })

  it('hält die Kastenhöhe im Bahnendiagramm fest und verbreitert stattdessen', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!(
      {
        id: 'p-1',
        name: 'ablauf',
        diagram: {
          ...bahnenSpec,
          steps: [
            { id: 's1', label: 'Zugriff auf Ressourcengruppe beantragt (SAP/BTP/Azure)', lane: 0, kind: 'terminal' },
            { id: 's2', label: 'Prüfen', lane: 1 },
          ],
          edges: [{ from: 's1', to: 's2' }],
        },
      },
      authExtra,
    )
    const svg = bodyOf(spy).content as string

    // Die Höhe ist Teil des Rasters: Alle Schritte stehen auf einer Linie, ein
    // einzelner höherer Kasten bricht die Reihe sichtbar auf. Der lange Text
    // macht den Kasten deshalb BREITER, nicht höher …
    const hoehen = [...svg.matchAll(/height=&quot;(\d+)&quot;/g)].map((m) => m[1])
    expect(hoehen.filter((h) => h !== '225')).toEqual(['48', '48'])
    expect(svg).toContain('width=&quot;180&quot;')
    // … und der folgende Schritt rückt um die Mehrbreite nach, statt sich zu
    // überlappen (36 + 180 + 35 Zwischenraum).
    expect(svg).toContain('x=&quot;251&quot;')
  })

  it('bricht lange Beschriftungen um, statt sie über den Kasten laufen zu lassen', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!(
      {
        id: 'p-1',
        name: 'ablauf',
        diagram: {
          ...bahnenSpec,
          steps: [{ id: 's1', label: 'Betriebshandbuch vollständig prüfen und freigeben', lane: 0 }],
          edges: [],
        },
      },
      authExtra,
    )
    const svg = bodyOf(spy).content as string
    const tspans = svg.match(/<tspan/g) ?? []
    // Mehr als eine Zeile — und keine davon länger, als 150 Punkte bei 12er
    // Schrift tragen (der alte Generator brach stur nach zwanzig Zeichen um und
    // ließ die Beschriftung dadurch überlaufen).
    expect(tspans.length).toBeGreaterThan(1)
  })

  it('übernimmt beim Flussdiagramm die Koordinaten des Agenten unverändert', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!(
      {
        id: 'p-1',
        name: 'fluss',
        diagram: {
          kind: 'flow',
          nodes: [
            { id: 'n1', label: 'Start', kind: 'terminal', x: 190, y: 20 },
            { id: 'n2', label: 'Weiter?', kind: 'decision', x: 185, y: 150 },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      },
      authExtra,
    )
    const svg = bodyOf(spy).content as string
    expect(svg).toContain('x="190" y="20"')
    expect(svg).toContain('#efaa00') // Entscheidung in Bernstein
  })

  it('meldet eine unschlüssige Beschreibung im Klartext und schreibt NICHT', async () => {
    const spy = mockFetch()
    const ergebnis = await tools().get('save_diagram')!(
      {
        id: 'p-1',
        name: 'ablauf',
        diagram: { ...bahnenSpec, edges: [{ from: 's1', to: 'gibtesnicht' }] },
      },
      authExtra,
    )

    expect(ergebnis.isError).toBe(true)
    expect(textOf(ergebnis)).toContain('gibtesnicht')
    // Das ist der eigentliche Punkt: keine kaputte Grafik im Repository.
    expect(spy).not.toHaveBeenCalled()
  })

  it('meldet eine Bahn außerhalb der Liste, ohne zu schreiben', async () => {
    const spy = mockFetch()
    const ergebnis = await tools().get('save_diagram')!(
      { id: 'p-1', name: 'ablauf', diagram: { ...bahnenSpec, steps: [{ id: 's1', label: 'X', lane: 7 }], edges: [] } },
      authExtra,
    )

    expect(ergebnis.isError).toBe(true)
    expect(textOf(ergebnis)).toContain('Bahn 7')
    expect(spy).not.toHaveBeenCalled()
  })

  it('reicht ifAbsent durch, damit ein fremdes Diagramm nicht überschrieben wird', async () => {
    const spy = mockFetch()
    await tools().get('save_diagram')!(
      { id: 'p-1', name: 'ablauf', diagram: bahnenSpec, ifAbsent: true },
      authExtra,
    )
    expect(bodyOf(spy).ifAbsent).toBe(true)
  })

  it('nennt Pfad und Markdown, damit das Diagramm im selben Arbeitsgang in den Text kommt', async () => {
    mockFetch([respond(200, { path: '_media/ablauf.drawio.svg' })])
    const ergebnis = await tools().get('save_diagram')!(
      { id: 'p-1', name: 'ablauf', title: 'Freigabeablauf', diagram: bahnenSpec },
      authExtra,
    )
    const text = textOf(ergebnis)
    expect(text).toContain('_media/ablauf.drawio.svg')
    expect(text).toContain('![Freigabeablauf](_media/ablauf.drawio.svg)')
  })
})

describe('attach_file', () => {
  it('gibt den fertigen Befehl samt Markdown-Schnipsel aus und transportiert nichts', async () => {
    const spy = mockFetch([respond(200, { branch: 'draft/p-1', baseSha: 'abc' })])
    const ergebnis = await tools().get('attach_file')!(
      { id: 'p-1', filename: 'bildschirmabzug.png' },
      authExtra,
    )
    const text = textOf(ergebnis)

    // Der Entwurfszustand wird gelesen, nicht angelegt.
    expect(callOf(spy).url.pathname).toBe('/api/pages/p-1/draft')
    expect(callOf(spy).init.method ?? 'GET').toBe('GET')

    expect(text).toContain('bildschirmabzug.png')
    expect(text).toContain('/api/pages/p-1/draft/media')
    expect(text).toContain('curl')
    expect(text).toContain('![bildschirmabzug](_media/bildschirmabzug.png)')
    // Erlaubte Endungen und Größengrenze, damit niemand in eine Ablehnung läuft.
    expect(text).toContain('pdf')
    expect(text).toContain('10 MB')
  })

  it('verweist ohne offenen Entwurf auf edit_page statt einen Befehl auszugeben', async () => {
    mockFetch([respond(404, { status: 'not_found', reason: 'Kein Entwurf' })])
    const ergebnis = await tools().get('attach_file')!({ id: 'p-1', filename: 'plan.pdf' }, authExtra)
    const text = textOf(ergebnis)

    expect(text).toContain('edit_page')
    // Ein Befehl, der sicher in einen 404 läuft, wäre schlimmer als keiner.
    expect(text).not.toContain('curl')
  })

  it('sagt einem Agenten ohne Kommandozeile, dass er die Datei nicht anhängen kann', async () => {
    mockFetch([respond(200, { branch: 'draft/p-1', baseSha: 'abc' })])
    const ergebnis = await tools().get('attach_file')!({ id: 'p-1', filename: 'plan.pdf' }, authExtra)
    expect(textOf(ergebnis)).toContain('Kommandozeile')
  })
})
