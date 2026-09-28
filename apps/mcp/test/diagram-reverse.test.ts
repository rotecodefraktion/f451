import { describe, expect, it } from 'vitest'
import { generateDiagram, type DiagramSpec } from '../src/diagram/generate.js'
import { normalform, specAusSvg } from '../src/diagram/reverse.js'

/** Paket 7 (#72): aus einem erzeugten Diagramm die Beschreibung zurückgewinnen. */

const bahnen: DiagramSpec = {
  kind: 'swimlane',
  lanes: ['SAP-Basis', 'Azure-Plattform'],
  steps: [
    { id: 'a', label: 'Start', lane: 0, kind: 'terminal' },
    { id: 'b', label: 'VM stoppen & sichern', lane: 1 },
    { id: 'c', label: 'Prüfen "ok?" <jetzt>', lane: 0 },
    { id: 'd', label: 'Ende', lane: 1, kind: 'terminal' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', label: 'gesichert' },
    { from: 'c', to: 'd' },
  ],
}

const fluss: DiagramSpec = {
  kind: 'flow',
  nodes: [
    { id: 's', label: 'Start', kind: 'terminal', x: 40, y: 20 },
    { id: 'q', label: 'Backup ok?', kind: 'decision', x: 40, y: 110 },
    { id: 'p', label: 'Neu starten', kind: 'step', x: 280, y: 125 },
    { id: 'e', label: 'Ende', kind: 'terminal', x: 40, y: 240 },
  ],
  edges: [
    { from: 's', to: 'q' },
    { from: 'q', to: 'p', label: 'nein' },
    { from: 'q', to: 'e', label: 'ja' },
  ],
}

describe('specAusSvg', () => {
  it('Bahnendiagramm: zurückgewonnen und neu gezeichnet ergibt dasselbe SVG', () => {
    const svg = generateDiagram(bahnen)
    const spec = specAusSvg(svg)
    expect(spec).toEqual(bahnen)
    expect(generateDiagram(spec!)).toBe(svg)
  })

  it('Flussdiagramm: Lage und Maße bleiben, Neuzeichnen ergibt dasselbe SVG', () => {
    const svg = generateDiagram(fluss)
    const spec = specAusSvg(svg)
    expect(spec!.kind).toBe('flow')
    expect(generateDiagram(spec!)).toBe(svg)
  })

  it('Flussdiagramm: eigene Kastengröße des Autors bleibt erhalten', () => {
    const gross: DiagramSpec = {
      kind: 'flow',
      nodes: [{ id: 'k', label: 'Ausgabe', kind: 'step', x: 500, y: 120, w: 220, h: 120 }],
      edges: [],
    }
    const spec = specAusSvg(generateDiagram(gross))
    expect(spec).toEqual(gross)
  })

  it('fremde Diagramme (ohne Generator-Marker) werden nicht angefasst', () => {
    const importiert =
      '<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile host=&quot;app.diagrams.net&quot;&gt;&lt;diagram id=&quot;d1&quot; name=&quot;Ablauf&quot;&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"><rect/></svg>'
    expect(specAusSvg(importiert)).toBeNull()
  })

  it('Normalform gleicht die Neuserialisierung des Sanitizers aus', () => {
    const svg = generateDiagram(bahnen)
    const wieGespeichert = svg.replace(/&quot;/g, '&#x22;').replace(/<rect([^>]*)\/>/g, '<rect$1></rect>')
    expect(wieGespeichert).not.toBe(svg)
    expect(normalform(wieGespeichert)).toBe(normalform(svg))
  })
})
