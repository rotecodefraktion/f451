import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { GraphData } from './types.js'

export interface NodePosition { x: number; y: number }

/** Node-/Link-Datentyp der Simulation — `id` explizit (nicht optional), damit
 *  `forceLink().id()` unten typkorrekt an `SimNode` bindet statt an das
 *  generische `SimulationNodeDatum` (das keine `id`-Eigenschaft kennt). */
interface SimNode {
  id: string
  x: number
  y: number
}
interface SimLink {
  source: string
  target: string
}

/** Zeichenfläche des Graph-SVG — viewBox-Maße aus dem Mockup (1000×560). */
export const GRAPH_VIEW = { width: 1000, height: 560, padding: 40 } as const

/** Angenommene Größe des Detail-Popovers (`.canvas .pop`, `app/graph.css`:
 *  `width: 250px`) für {@link clampPopoverPosition} — die Höhe ist eine
 *  KONSERVATIVE Schätzung (der tatsächliche Inhalt variiert, z. B. je nach
 *  Anzahl umbrechender Tags); `.pop`s CSS-`max-height`+`overflow:auto` fängt
 *  eine zu knappe Schätzung als Sicherheitsnetz ab (Bugfix „Graph-Popover
 *  überlappt Rand/Button"). */
export const POPOVER_SIZE = { width: 250, height: 280 } as const

export interface ContainerSize { width: number; height: number }

/**
 * Statisches Force-Layout: die Simulation wird SYNCHRON durchgetickt (kein
 * requestAnimationFrame, keine Animation — das Mockup ist ein statisches
 * Standbild) und liefert deterministische Koordinaten: d3-force platziert
 * initial per Phyllotaxis und jittert mit einem festen LCG — gleicher Input
 * ergibt exakt dasselbe Layout (so bleibt die Funktion unit-testbar).
 */
export function computeLayout(graph: GraphData): Map<string, NodePosition> {
  if (graph.nodes.length === 0) return new Map()
  const simNodes: SimNode[] = graph.nodes.map((n) => ({ id: n.id, x: 0, y: 0 }))
  const simLinks: SimLink[] = graph.edges.map((e) => ({ source: e.from, target: e.to }))
  const sim = forceSimulation<SimNode>(simNodes)
    .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(90).strength(0.6))
    .force('charge', forceManyBody().strength(-220))
    .force('center', forceCenter(GRAPH_VIEW.width / 2, GRAPH_VIEW.height / 2))
    .force('collide', forceCollide(30))
    .stop()
  for (let i = 0; i < 300; i++) sim.tick()
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return new Map(
    simNodes.map((n) => [
      n.id,
      {
        x: clamp(n.x, GRAPH_VIEW.padding, GRAPH_VIEW.width - GRAPH_VIEW.padding),
        y: clamp(n.y, GRAPH_VIEW.padding, GRAPH_VIEW.height - GRAPH_VIEW.padding),
      },
    ]),
  )
}

/**
 * Wandelt eine Knoten-Position (Viewbox-Koordinaten, {@link GRAPH_VIEW}) in
 * eine PIXEL-Position innerhalb des `.canvas`-Containers um und klemmt sie so,
 * dass ein Popover der Größe `popover` nie über den Container-Rand
 * hinausragt — an den Rändern „kippt" die Position dadurch nach oben/links,
 * statt das Popover abzuschneiden (Bugfix „Graph-Popover überlappt
 * Rand/Button", `graph-view.tsx`s bisherige rohe `%`-Positionierung hatte
 * keine Rand-Kollisionsprüfung).
 *
 * Berücksichtigt das Letterboxing von `preserveAspectRatio="xMidYMid meet"`
 * (die SVG füllt `.canvas` NICHT zwangsläufig randlos, wenn deren
 * Seitenverhältnis von `GRAPH_VIEW` abweicht) — ohne diese Umrechnung würde
 * die Pixel-Position bei einem nicht-1000:560-Container systematisch daneben
 * liegen. Ohne bekannte (gemessene) Container-Größe (`container.width`/
 * `height` ⇐ 0, z. B. der allererste Render vor dem Messen per
 * `ResizeObserver`) liefert sie den `margin`-Wert für beide Achsen — ein
 * sicherer, immer sichtbarer Fallback statt `NaN`/negativer Positionen.
 */
export function clampPopoverPosition(
  pos: NodePosition,
  container: ContainerSize,
  popover: { width: number; height: number } = POPOVER_SIZE,
  margin = 8,
): { left: number; top: number } {
  if (container.width <= 0 || container.height <= 0) {
    return { left: margin, top: margin }
  }

  const scale = Math.min(container.width / GRAPH_VIEW.width, container.height / GRAPH_VIEW.height)
  const offsetX = (container.width - GRAPH_VIEW.width * scale) / 2
  const offsetY = (container.height - GRAPH_VIEW.height * scale) / 2
  const nodePxX = offsetX + pos.x * scale
  const nodePxY = offsetY + pos.y * scale

  const maxLeft = Math.max(margin, container.width - popover.width - margin)
  const maxTop = Math.max(margin, container.height - popover.height - margin)
  return {
    left: Math.min(Math.max(nodePxX, margin), maxLeft),
    top: Math.min(Math.max(nodePxY, margin), maxTop),
  }
}
