/**
 * Der Hausstil der Diagramme, gelesen aus dem Token-Katalog.
 *
 * Liegt im Token-Paket statt im MCP-Dienst, weil zwei Stellen daraus zeichnen:
 * der Generator (`apps/mcp/src/diagram/generate.ts`) und die Formenbibliothek
 * des draw.io-Editors (`apps/web/lib/editor/drawio-library.ts`). Beide müssen
 * dieselben Stil-Zeichenketten tragen, sonst sähe ein erzeugtes Kästchen anders
 * aus als ein aus der Bibliothek gezogenes (Spec MCP-Anhänge, User Story 21).
 *
 * Es gibt hier bewusst KEINE eigenen Werte. Farben, Maße und Rasterabstände
 * stehen einmal in `@f451/design-tokens` (Gruppe „Diagramme", Herkunft:
 * `docs/design/diagramm-vorlagen/`) und werden dort auch auf der
 * Einstellungsseite „Erscheinungsbild" angezeigt. Eine zweite Werteliste im
 * Dienst liefe still auseinander — und zwar in die Richtung, die niemandem
 * auffällt: Der Generator zeichnete weiter in den alten Farben, während die
 * Einstellungsseite die neuen zeigt.
 *
 * Was dieses Modul beisteuert, ist die Übersetzung von zwei Token-Werten (hell,
 * dunkel) in EINE Zeichenkette, die im SVG steht.
 */

import { design } from './tokens.js'

type ColorToken = keyof typeof design.light & `--diagram-${string}`
type SizeToken = keyof typeof design.structure & `--diagram-${string}`

/**
 * Farbwert für das SVG — als Zwei-Modi-Schreibweise, sobald sich Hell und
 * Dunkel unterscheiden.
 *
 * `light-dark()` ist die einzige Möglichkeit, ein Diagramm auf den
 * Erscheinungsmodus reagieren zu lassen: Ein Diagramm wird als Bild
 * eingebunden, und ein SVG in einem Bild-Element ist ein abgeschottetes
 * Dokument — die CSS-Variablen der Anwendung existieren dort nicht. Die
 * Zwei-Modi-Schreibweise dagegen wertet der Browser innerhalb des SVG aus und
 * braucht nichts von außen.
 *
 * Wo beide Modi denselben Wert tragen, steht der Wert schlicht da. Das ist
 * nicht nur kürzer, es entspricht auch den Vorlagen: Sie führen die
 * Zwei-Modi-Schreibweise an genau der einen Stelle, an der sie etwas ändert.
 */
export function farbe(token: ColorToken): string {
  const hell = design.light[token]
  const dunkel = design.dark[token]
  return hell === dunkel ? hell : `light-dark(${hell},${dunkel})`
}

/**
 * Maß als Zahl.
 *
 * Die Diagramm-Maße sind einheitenlos abgelegt (mxGraph-Geometrie kennt keine
 * Einheit, das SVG rechnet in denselben Zahlen) — deshalb genügt `Number`,
 * ohne Einheiten abzuschneiden.
 */
export function mass(token: SizeToken): number {
  const wert = Number(design.structure[token])
  if (!Number.isFinite(wert)) {
    throw new Error(`Diagramm-Token ${token} ist keine Zahl: "${design.structure[token]}"`)
  }
  return wert
}

/** Die Schriftfamilie der Beschriftungen — als Zeichenkette, nicht als Zahl. */
export const schriftFamilie = design.structure['--diagram-font-family']

/**
 * Der Stil, mit dem gezeichnet wird — einmal aufgelöst, damit weder Zeichnung
 * noch mxGraph-XML den Katalog ein zweites Mal befragen (und dabei abweichen
 * könnten).
 */
export const stil = {
  laneFill: farbe('--diagram-lane-fill'),
  laneStroke: farbe('--diagram-lane-stroke'),
  laneLabel: farbe('--diagram-lane-label'),
  terminalFill: farbe('--diagram-terminal-fill'),
  terminalStroke: farbe('--diagram-terminal-stroke'),
  stepFill: farbe('--diagram-step-fill'),
  stepStroke: farbe('--diagram-step-stroke'),
  flowStepStroke: farbe('--diagram-flow-step-stroke'),
  decisionFill: farbe('--diagram-decision-fill'),
  decisionStroke: farbe('--diagram-decision-stroke'),
  labelColor: farbe('--diagram-label-color'),
  edgeColor: farbe('--diagram-edge-color'),

  laneH: mass('--diagram-lane-h'),
  laneTitleW: mass('--diagram-lane-title-w'),
  laneStepW: mass('--diagram-lane-step-w'),
  laneStepH: mass('--diagram-lane-step-h'),
  laneStepGap: mass('--diagram-lane-step-gap'),
  flowNodeW: mass('--diagram-flow-node-w'),
  flowNodeH: mass('--diagram-flow-node-h'),
  flowTerminalH: mass('--diagram-flow-terminal-h'),
  flowDecisionW: mass('--diagram-flow-decision-w'),
  flowDecisionH: mass('--diagram-flow-decision-h'),
  flowRowGap: mass('--diagram-flow-row-gap'),
  cornerArc: mass('--diagram-corner-arc'),
  fontFamily: schriftFamilie,
  fontSize: mass('--diagram-font-size'),
} as const

/**
 * Die mxGraph-Stil-Zeichenketten der Vorlagen, Schlüssel für Schlüssel.
 *
 * Nicht nur die Farben: Das XML muss dieselben Schlüssel tragen wie ein von
 * Hand gezeichnetes Diagramm (`rounded`, `arcSize`, `whiteSpace`, `html`,
 * `align`, `verticalAlign`, `fontFamily`, `fontSize`, `fontColor`), sonst sieht
 * ein erzeugtes Diagramm im Editor anders aus als ein gezeichnetes — siehe
 * `docs/design/diagramm-vorlagen/README.md`.
 */
const schrift = `align=center;verticalAlign=middle;fontFamily=${stil.fontFamily};fontSize=${stil.fontSize};fontColor=${stil.labelColor};`

export const mxStil = {
  entscheidung: `rhombus;whiteSpace=wrap;html=1;fillColor=${stil.decisionFill};strokeColor=${stil.decisionStroke};${schrift}`,
  anfangEnde: `rounded=1;whiteSpace=wrap;html=1;arcSize=${stil.cornerArc};fillColor=${stil.terminalFill};strokeColor=${stil.terminalStroke};${schrift}`,
  /** Im Bahnendiagramm und im Flussdiagramm unterscheidet sich nur der Rand. */
  schritt: (variante: 'swimlane' | 'flow') =>
    `rounded=0;whiteSpace=wrap;html=1;fillColor=${stil.stepFill};strokeColor=${variante === 'swimlane' ? stil.stepStroke : stil.flowStepStroke};${schrift}`,
  /**
   * `swimlaneFillColor` steht neben `fillColor`, weil draw.io eine Bahn aus zwei
   * Flächen zeichnet: `fillColor` färbt den Kopf mit der Beschriftung,
   * `swimlaneFillColor` den Körper daneben. Ohne den zweiten Schlüssel bleibt der
   * Körper im Editor ungefüllt (Vorlage `bahnendiagramm.mxgraph.xml`, `lane1`).
   */
  bahn: `swimlane;html=1;horizontal=0;startSize=${stil.laneTitleW};fillColor=${stil.laneFill};swimlaneFillColor=${stil.laneFill};strokeColor=${stil.laneStroke};fontStyle=1;fontColor=${stil.laneLabel};`,
  kante: `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=${stil.edgeColor};`,
} as const
