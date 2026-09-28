import type { DiagramEdge, DiagramSpec, FlowNode, SwimlaneStep } from './generate.js'

/**
 * Gewinnt aus einem vom Generator erzeugten Diagramm die BESCHREIBUNG zurück
 * (MCP-Anhänge, Paket 7: Auffrisch-Lauf). Mit ihr zeichnet `generateDiagram`
 * das Diagramm in den aktuellen Token-Werten neu — Grafik und eingebettetes
 * mxGraph-XML bleiben dabei deckungsgleich, weil beide wieder aus derselben
 * Beschreibung entstehen.
 *
 * Nur für Diagramme des Generators: Sie tragen den Pfeilmarker `f451-arrow`.
 * Das Importskript (`drawio-svg.mjs` (früheres Import-Skript, nicht Teil dieses Repos)) setzt denselben
 * mxfile-Kopf, aber nie diesen Marker; von Hand gezeichnete Diagramme ohnehin
 * nicht. Deren Struktur ist beliebig — für sie liefert die Funktion `null`,
 * und der Lauf lässt sie stehen (Entscheidung #72: Import-Diagramme behalten
 * ihre Palette).
 *
 * Im Flussdiagramm übernimmt die Rückgewinnung Lage UND Maße jedes Kastens.
 * Ob ein Maß vom Aufrufer stammte oder das Hausmaß war, steht nicht im XML;
 * im Zweifel bleibt die Geometrie des Autors (am echten Bestand gefunden: ein
 * Diagramm mit bewusst größeren Kästen, 220 × 120 statt 170 × 80). Aufgefrischt
 * werden dann Farben und Schrift, nicht die Kastengrößen.
 */
export function specAusSvg(svg: string): DiagramSpec | null {
  if (!svg.includes('id="f451-arrow"')) return null
  const content = /\scontent="([^"]*)"/.exec(svg)?.[1]
  if (content === undefined) return null
  const zellen = zellenAus(entities(content))

  const kanten: DiagramEdge[] = zellen
    .filter((z) => z.attr.edge === '1')
    .map((z) => ({ from: z.attr.source ?? '', to: z.attr.target ?? '', ...(z.attr.value ? { label: z.attr.value } : {}) }))
  const knoten = zellen.filter((z) => z.attr.vertex === '1')
  const bahnen = knoten.filter((z) => z.attr.style?.startsWith('swimlane')).sort((a, b) => a.geo.y - b.geo.y)

  if (bahnen.length > 0) {
    const bahnHoehe = bahnen[0]!.geo.h
    const steps: SwimlaneStep[] = knoten
      .filter((z) => !z.attr.style?.startsWith('swimlane'))
      .sort((a, b) => a.geo.x - b.geo.x)
      .map((z) => ({
        id: z.attr.id!,
        label: z.attr.value ?? '',
        lane: Math.max(0, Math.min(bahnen.length - 1, Math.floor((z.geo.y + z.geo.h / 2) / bahnHoehe))),
        ...(z.attr.style?.includes('rounded=1') ? { kind: 'terminal' as const } : {}),
      }))
    return { kind: 'swimlane', lanes: bahnen.map((b) => b.attr.value ?? ''), steps, edges: kanten }
  }

  const nodes: FlowNode[] = knoten.map((z) => ({
    id: z.attr.id!,
    label: z.attr.value ?? '',
    kind: z.attr.style?.startsWith('rhombus') ? 'decision' : z.attr.style?.includes('rounded=1') ? 'terminal' : 'step',
    x: z.geo.x,
    y: z.geo.y,
    w: z.geo.w,
    h: z.geo.h,
  }))
  return { kind: 'flow', nodes, edges: kanten }
}

interface Zelle {
  attr: Record<string, string>
  geo: { x: number; y: number; w: number; h: number }
}

/** Liest die `mxCell`-Elemente des vom Generator geschriebenen XML. Ein
 *  eigener, schmaler Leser statt eines XML-Parsers: Das Format stammt aus
 *  `generate.ts` und ist bekannt; der Dienst bleibt ohne DOM-Abhängigkeit. */
function zellenAus(xml: string): Zelle[] {
  const zellen: Zelle[] = []
  for (const m of xml.matchAll(/<mxCell\s([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g)) {
    const attr = attribute(m[1]!)
    const g = attribute(/<mxGeometry\s([^>]*?)\/?>/.exec(m[2] ?? '')?.[1] ?? '')
    zellen.push({
      attr,
      geo: { x: Number(g.x ?? 0), y: Number(g.y ?? 0), w: Number(g.width ?? 0), h: Number(g.height ?? 0) },
    })
  }
  return zellen
}

function attribute(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]!] = entities(m[2]!)
  return out
}

/**
 * Vergleichsform eines gespeicherten Diagramms. Der SVG-Sanitizer der API
 * serialisiert beim Speichern neu: `&quot;` wird `&#x22;`, `<rect/>` wird
 * `<rect></rect>`. Derselbe Inhalt, andere Bytes — ohne diese Angleichung hielte
 * der Auffrisch-Lauf jedes gespeicherte Diagramm für veraltet.
 */
export function normalform(svg: string): string {
  return entities(svg).replace(/<([\w:-]+)((?:\s[^<>]*?)?)\s*\/>/g, '<$1$2></$1>')
}

function entities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}
