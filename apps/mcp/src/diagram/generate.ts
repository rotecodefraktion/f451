/**
 * Diagramm-Generator: Beschreibung → `.drawio.svg`.
 *
 * Ein draw.io-Diagramm ist ein SVG, das die gezeichnete Grafik **und** das
 * mxGraph-XML im `content`-Attribut des Wurzelelements trägt. Beide müssen
 * deckungsgleich sein — läuft eines dem anderen davon, sieht das Diagramm im
 * Editor anders aus als in der Leseansicht. Genau deshalb nimmt `save_diagram`
 * eine Beschreibung entgegen und kein fertiges SVG: Ein Agent, der das von Hand
 * konstruiert, hat keine Möglichkeit, das Ergebnis zu prüfen.
 *
 * Herkunft: `drawio-svg.mjs` (früheres Import-Skript, nicht Teil dieses Repos) aus einem früheren Dokumentimport. Übernommen
 * ist die Erzeugungslogik (Ports, orthogonale Kantenführung, doppelte Ausgabe
 * in Zeichnung und XML), ersetzt sind drei Dinge:
 *
 * 1. **Die Stilwerte** kommen aus dem Token-Katalog (`style.ts`) statt fest aus
 *    dem Code. Der Pilot zeichnete in anderen Farben und Maßen als die
 *    Vorlagen des Auftraggebers.
 * 2. **`color-scheme: light dark`** steht in jedem erzeugten SVG. Gemessen am
 *    2026-07-27: Ohne diese Deklaration wertet ein als Bild eingebundenes SVG
 *    die Zwei-Modi-Schreibweise `light-dark()` NICHT aus — heller und dunkler
 *    Modus rendern bitgleich, der Wert fällt stumm auf die helle Fassung
 *    zurück, ohne Fehler und ohne Warnung.
 * 3. **Der Zeilenumbruch** rechnet aus Kastenbreite und Schriftgröße statt nach
 *    fester Zeichenzahl (der Pilot brach stur nach zwanzig Zeichen um). Das ist
 *    der Grund, aus dem Beschriftungen abgeschnitten wirkten — er lag nicht am
 *    Sanitizer.
 */

import { mxStil, stil } from './style.js'

// --- Beschreibung ---------------------------------------------------------

export interface DiagramEdge {
  from: string
  to: string
  label?: string
}

/** Ein Schritt im Bahnendiagramm — ohne Koordinaten, die rechnet der Dienst. */
export interface SwimlaneStep {
  id: string
  label: string
  /** Nullbasierter Index in `lanes`. */
  lane: number
  /** `terminal` = Anfang oder Ende der Kette; ohne Angabe ein gewöhnlicher Schritt. */
  kind?: 'step' | 'terminal'
}

export interface SwimlaneSpec {
  kind: 'swimlane'
  /** Bahnen von oben nach unten. */
  lanes: string[]
  /** Schritte in der Reihenfolge der Prozesskette — sie bestimmt die waagerechte Lage. */
  steps: SwimlaneStep[]
  edges: DiagramEdge[]
}

/** Ein Knoten im Flussdiagramm — hier setzt der Agent die Koordinaten selbst. */
export interface FlowNode {
  id: string
  label: string
  kind: 'terminal' | 'step' | 'decision'
  x: number
  y: number
  /** Abweichende Maße; ohne Angabe die Hausmaße der jeweiligen Art. */
  w?: number
  h?: number
}

export interface FlowSpec {
  kind: 'flow'
  nodes: FlowNode[]
  edges: DiagramEdge[]
}

export type DiagramSpec = SwimlaneSpec | FlowSpec

/** Ein Kasten, wie ihn Zeichnung und XML gemeinsam brauchen. */
interface Box {
  id: string
  label: string
  kind: 'terminal' | 'step' | 'decision'
  x: number
  y: number
  w: number
  h: number
  /** Die beiden Diagrammarten umranden ihre Schritte verschieden (s. Katalog). */
  variant: 'swimlane' | 'flow'
  /** Vorgerechneter Zeilenumbruch — Zeichnung und Kastenhöhe hängen daran. */
  lines: string[]
}

// --- Textmaß und Umbruch --------------------------------------------------

/**
 * Breite eines Zeichens in em, Helvetica.
 *
 * Die Werte stammen aus den Adobe-Metriken der Schrift (dort in 1/1000 em) und
 * sind auf die Gruppen zusammengefasst, die sich tatsächlich unterscheiden. Das
 * ist genauer als jede Zeichenzahl und ungenauer als echtes Ausmessen — für die
 * Frage „passt die Zeile in den Kasten" reicht es, und es kommt ohne
 * Schriftbibliothek aus, die der Dienst sonst nirgends braucht.
 *
 * Umlaute und ß fallen in die Grundbreite der Kleinbuchstaben; das ist in
 * Helvetica auch ihre tatsächliche Breite.
 */
function charEm(ch: string): number {
  if ('ijl'.includes(ch)) return 0.222
  if (" tfI.,:;'!|[]".includes(ch)) return 0.278
  if ('r()/\\`-'.includes(ch)) return 0.333
  if ('mMW'.includes(ch)) return 0.85
  if (ch === 'w') return 0.722
  if (ch >= 'A' && ch <= 'Z') return 0.68
  return 0.556
}

function textWidth(text: string, fontSize: number): number {
  let em = 0
  for (const ch of text) em += charEm(ch)
  return em * fontSize
}

/** Innenabstand des Textes zum Kastenrand, je Seite — wie in draw.io. */
const PAD_X = 6
const PAD_Y = 4

/** Zeilenhöhe als Vielfaches der Schriftgröße (draw.io rechnet mit 1,2). */
const LINE_HEIGHT = 1.2

/**
 * Der Papiergrund des Diagramms — Fläche des Blattes und Unterlegung der
 * Kantenbeschriftungen.
 *
 * Kein Token, sondern eine Konstante: Dies ist kein Gestaltungswert, sondern
 * die Zusage, dass hinter dem Diagramm nichts durchscheint. Der dunkle Wert
 * ist der Papierton der Anwendung (`--color-bg` dunkel) — ein weißes Blatt im
 * Dunkelmodus wäre genau die helle Kachel, die Nutzergeschichte 22 ausschließt.
 */
const PAPIER = 'light-dark(#ffffff,#1a1917)'

/**
 * Bricht eine Beschriftung auf die nutzbare Kastenbreite um.
 *
 * Ein Wort, das allein schon breiter ist als die Zeile, wird hart getrennt.
 * Das ist hässlich, aber ehrlich: Die Alternative wäre ein Wort, das über den
 * Kastenrand hinausragt — und das sieht nach einem Fehler aus, den niemand
 * mehr dem Text zuordnet.
 */
function wrapLabel(text: string, boxWidth: number, fontSize: number): string[] {
  const usable = Math.max(boxWidth - 2 * PAD_X, fontSize)
  const lines: string[] = []
  let current = ''

  const pushWord = (word: string) => {
    const probe = current ? `${current} ${word}` : word
    if (textWidth(probe, fontSize) <= usable) {
      current = probe
      return
    }
    if (current) {
      lines.push(current)
      current = ''
    }
    if (textWidth(word, fontSize) <= usable) {
      current = word
      return
    }
    // Hart trennen: zeichenweise füllen, bis die Zeile voll ist.
    let rest = word
    while (textWidth(rest, fontSize) > usable) {
      let cut = 1
      while (cut < rest.length && textWidth(rest.slice(0, cut + 1), fontSize) <= usable) cut++
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    current = rest
  }

  for (const word of String(text).split(/\s+/).filter(Boolean)) pushWord(word)
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/**
 * Höhe, die der umbrochene Text mindestens braucht — auf ganze Einheiten
 * aufgerundet.
 *
 * Ganzzahlig, weil dieselbe Zahl in die mxGeometry wandert: `height="51.2"`
 * wäre gültig, aber `51.199999999999996` (das Ergebnis von 3 × 12 × 1,2 + 8 in
 * Fließkomma) steht so in einer Datei, die Menschen im Editor wiedersehen.
 */
function neededHeight(lines: string[], fontSize: number): number {
  return Math.ceil(lines.length * fontSize * LINE_HEIGHT + 2 * PAD_Y)
}

/** Wie viele Zeilen in einen Kasten dieser Höhe passen. */
function fittingLines(height: number, fontSize: number): number {
  return Math.max(1, Math.floor((height - 2 * PAD_Y) / (fontSize * LINE_HEIGHT)))
}

/**
 * Verbreitert einen Kasten, bis die Beschriftung in die vorgegebene Höhe passt.
 *
 * Im Bahnendiagramm ist die Kastenhöhe Teil des Rasters: Alle Schritte stehen
 * auf einer Linie, und ein einzelner höherer Kasten bricht die Reihe sichtbar
 * auf. Wächst stattdessen die Breite, bleibt die Reihe ruhig — der Preis ist
 * ein breiteres Blatt, und das fällt bei einem Prozessdiagramm, das ohnehin in
 * die Breite läuft, nicht ins Gewicht.
 *
 * Die Obergrenze ist eine Notbremse gegen Beschriftungen, die kein
 * Diagrammkasten fassen kann: Ab dem Dreifachen der Hausbreite wächst wieder
 * die Höhe, statt das Blatt kilometerbreit zu machen. Wer dort landet, hat
 * einen Absatz in einen Kasten geschrieben.
 */
function fitToHeight(
  text: string,
  minWidth: number,
  height: number,
  fontSize: number,
): { w: number; h: number; lines: string[] } {
  const maxLines = fittingLines(height, fontSize)
  const maxWidth = minWidth * 3
  let w = minWidth
  let lines = wrapLabel(text, w, fontSize)
  while (lines.length > maxLines && w < maxWidth) {
    w = Math.min(w + 10, maxWidth)
    lines = wrapLabel(text, w, fontSize)
  }
  return { w, h: Math.max(height, neededHeight(lines, fontSize)), lines }
}

// --- SVG-Primitive --------------------------------------------------------

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function labelSvg(cx: number, cy: number, lines: string[], color: string, fontSize = stil.fontSize): string {
  const step = fontSize * LINE_HEIGHT
  const dy0 = -((lines.length - 1) * step) / 2
  const tspans = lines
    .map((line, i) => `<tspan x="${cx}" dy="${i === 0 ? round(dy0) : round(step)}">${esc(line)}</tspan>`)
    .join('')
  return (
    `<text x="${cx}" y="${cy}" font-family="${esc(stil.fontFamily)},Arial,sans-serif" font-size="${fontSize}" ` +
    `fill="${esc(color)}" text-anchor="middle" dominant-baseline="central">${tspans}</text>`
  )
}

/** Zwei Nachkommastellen genügen und halten die Datei lesbar. */
const round = (n: number): number => Math.round(n * 100) / 100

function boxSvg(box: Box): string {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  if (box.kind === 'decision') {
    return (
      `<polygon points="${cx},${box.y} ${box.x + box.w},${cy} ${cx},${box.y + box.h} ${box.x},${cy}" ` +
      `fill="${esc(stil.decisionFill)}" stroke="${esc(stil.decisionStroke)}" stroke-width="1.5"/>` +
      labelSvg(cx, cy, box.lines, stil.labelColor)
    )
  }
  const terminal = box.kind === 'terminal'
  const fill = terminal ? stil.terminalFill : stil.stepFill
  const stroke = terminal
    ? stil.terminalStroke
    : box.variant === 'swimlane'
      ? stil.stepStroke
      : stil.flowStepStroke
  // arcSize ist in mxGraph ein PROZENTWERT der kürzeren Seite; im SVG braucht
  // es einen Radius in Nutzereinheiten. Deshalb hier umgerechnet statt
  // übernommen — sonst wäre eine „40" im XML eine sanfte und im Bild eine
  // extreme Rundung.
  const rx = terminal ? (Math.min(box.w, box.h) * stil.cornerArc) / 100 : 0
  return (
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${round(rx)}" ry="${round(rx)}" ` +
    `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="1.5"/>` +
    labelSvg(cx, cy, box.lines, stil.labelColor)
  )
}

/** Anschlusspunkt an der Kastenseite, die zur Gegenseite zeigt. */
function port(box: Box, dx: number, dy: number): [number, number] {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? [cx, box.y + box.h] : [cx, box.y]
  return dx > 0 ? [box.x + box.w, cy] : [box.x, cy]
}

function edgeSvg(byId: Record<string, Box>, edge: DiagramEdge): string {
  const a = byId[edge.from]!
  const b = byId[edge.to]!
  const acx = a.x + a.w / 2
  const acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2
  const bcy = b.y + b.h / 2
  const [ax, ay] = port(a, bcx - acx, bcy - acy)
  const [bx, by] = port(b, acx - bcx, acy - bcy)

  let d: string
  let lx: number
  let ly: number
  if (Math.abs(ax - bx) < 2 || Math.abs(ay - by) < 2) {
    d = `M ${ax} ${ay} L ${bx} ${by}`
    lx = (ax + bx) / 2
    ly = (ay + by) / 2
  } else if (ay === a.y + a.h || ay === a.y) {
    const my = (ay + by) / 2
    d = `M ${ax} ${ay} L ${ax} ${my} L ${bx} ${my} L ${bx} ${by}`
    lx = (ax + bx) / 2
    ly = my
  } else {
    const mx = (ax + bx) / 2
    d = `M ${ax} ${ay} L ${mx} ${ay} L ${mx} ${by} L ${bx} ${by}`
    lx = mx
    ly = (ay + by) / 2
  }

  let label = ''
  if (edge.label) {
    // Die Unterlegung wird aus dem Text gerechnet, nicht fest gesetzt: Eine
    // feste Breite deckt „ja" ab und lässt „abgelehnt" über den Rand stehen.
    const fontSize = stil.fontSize - 1
    const w = textWidth(edge.label, fontSize) + 8
    const h = fontSize * LINE_HEIGHT + 4
    label =
      `<rect x="${round(lx - w / 2)}" y="${round(ly - h / 2)}" width="${round(w)}" height="${round(h)}" ` +
      `fill="${PAPIER}" opacity="0.85"/>` +
      `<text x="${round(lx)}" y="${round(ly)}" font-family="${esc(stil.fontFamily)},Arial,sans-serif" ` +
      `font-size="${fontSize}" fill="${esc(stil.edgeColor)}" text-anchor="middle" ` +
      `dominant-baseline="central">${esc(edge.label)}</text>`
  }
  return (
    `<path d="${d}" fill="none" stroke="${esc(stil.edgeColor)}" stroke-width="1.5" marker-end="url(#f451-arrow)"/>` +
    label
  )
}

// --- mxGraph --------------------------------------------------------------

function styleFor(box: Box): string {
  if (box.kind === 'decision') return mxStil.entscheidung
  if (box.kind === 'terminal') return mxStil.anfangEnde
  return mxStil.schritt(box.variant)
}

interface Lane {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}

function mxLane(lane: Lane): string {
  return (
    `<mxCell id="${esc(lane.id)}" value="${esc(lane.label)}" ` +
    `style="${mxStil.bahn}" ` +
    `vertex="1" parent="1"><mxGeometry x="${lane.x}" y="${lane.y}" width="${lane.w}" height="${lane.h}" as="geometry"/></mxCell>`
  )
}

function mxBox(box: Box): string {
  return (
    `<mxCell id="${esc(box.id)}" value="${esc(box.label)}" style="${styleFor(box)}" vertex="1" parent="1">` +
    `<mxGeometry x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" as="geometry"/></mxCell>`
  )
}

function mxEdge(edge: DiagramEdge, i: number): string {
  return (
    `<mxCell id="ed${i}" value="${esc(edge.label ?? '')}" ` +
    `style="${mxStil.kante}" ` +
    `edge="1" parent="1" source="${esc(edge.from)}" target="${esc(edge.to)}">` +
    `<mxGeometry relative="1" as="geometry"/></mxCell>`
  )
}

function mxfile(cells: string[], width: number, height: number): string {
  return (
    `<mxfile host="app.diagrams.net"><diagram id="d1" name="Ablauf">` +
    `<mxGraphModel dx="${Math.round(width)}" dy="${Math.round(height)}" grid="0" gridSize="10" guides="1" tooltips="1" ` +
    `connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1100" pageHeight="850" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`
  )
}

function svgWrap(width: number, height: number, inner: string, cells: string[]): string {
  const defs =
    `<defs><marker id="f451-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" ` +
    `markerUnits="strokeWidth"><path d="M0,0 L7,3 L0,6 z" fill="${esc(stil.edgeColor)}"/></marker></defs>`
  // `color-scheme` MUSS hier stehen, sonst bleibt jedes light-dark() wirkungslos
  // (gemessen 2026-07-27, s. Kopfkommentar).
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `style="color-scheme: light dark" content="${esc(mxfile(cells, width, height))}">` +
    `<rect width="${width}" height="${height}" fill="${PAPIER}"/>${defs}${inner}</svg>`
  )
}

// --- Erzeugung ------------------------------------------------------------

export function generateDiagram(spec: DiagramSpec): string {
  return spec.kind === 'swimlane' ? generateSwimlane(spec) : generateFlow(spec)
}

/** Luft zwischen Bahnenkopf und erstem Schritt (aus den Vorlagen: x = 36 bei Kopf 26). */
const LANE_PAD_X = 10

/**
 * Bahnendiagramm — die waagerechte Lage rechnet der Dienst.
 *
 * Die Schritte stehen in der Reihenfolge der Prozesskette, unabhängig davon, in
 * welcher Bahn sie liegen: Schritt 3 steht rechts von Schritt 2, auch wenn er
 * eine Bahn tiefer sitzt. Das entspricht der Form, die ein Prozessdiagramm
 * ohnehin hat — und es ist der Grund, aus dem der Agent keine Koordinaten
 * setzen muss, deren Ergebnis er nie zu sehen bekommt.
 */
function generateSwimlane(spec: SwimlaneSpec): string {
  // Der Zwischenraum, nicht der Rasterabstand, trägt die Anordnung: Solange
  // alle Kästen die Hausbreite haben, kommt exakt das Raster der Vorlage heraus
  // (36, 221, 406 …). Braucht einer mehr Breite, rücken die folgenden nach —
  // sonst überlappten sie.
  const zwischenraum = stil.laneStepGap - stil.laneStepW
  let x = stil.laneTitleW + LANE_PAD_X

  const boxes: Box[] = spec.steps.map((step) => {
    const { w, h, lines } = fitToHeight(step.label, stil.laneStepW, stil.laneStepH, stil.fontSize)
    const box: Box = {
      id: step.id,
      label: step.label,
      kind: step.kind === 'terminal' ? 'terminal' : 'step',
      x,
      y: Math.round(step.lane * stil.laneH + (stil.laneH - h) / 2),
      w,
      h,
      variant: 'swimlane',
      lines,
    }
    x += w + zwischenraum
    return box
  })

  const rightmost = boxes.reduce((max, b) => Math.max(max, b.x + b.w), 0)
  const width = Math.round(rightmost + LANE_PAD_X)
  const height = spec.lanes.length * stil.laneH

  const lanes: Lane[] = spec.lanes.map((label, i) => ({
    id: `lane${i}`,
    label,
    x: 0,
    y: i * stil.laneH,
    w: width,
    h: stil.laneH,
  }))

  const laneSvg = lanes
    .map((lane) => {
      // Der Bahnentitel steht gedreht: Seine Zeilenlänge wird an der HÖHE der
      // Bahn gemessen, seine Zeilenzahl an der Breite des Kopfs. Ohne diesen
      // Umbruch ragt ein längerer Name über die Bahn hinaus — in die
      // Nachbarbahn oder aus dem Bild. Zeilenhöhe hier ohne Durchschuss
      // (Faktor 1 statt 1,2), sonst passen schon zwei Zeilen nicht mehr in die
      // 26 Einheiten des Kopfs.
      const maxZeilen = Math.max(1, Math.floor(stil.laneTitleW / stil.fontSize))
      // 0,92 als Abschlag für den Fettschnitt: Die Breitentabelle in `charEm`
      // gilt für den normalen Schnitt, und der Bahnentitel steht fett.
      let zeilen = wrapLabel(lane.label, lane.h * 0.92, stil.fontSize)
      if (zeilen.length > maxZeilen) {
        zeilen = zeilen.slice(0, maxZeilen)
        zeilen[maxZeilen - 1] = `${zeilen[maxZeilen - 1]!} …`
      }
      const versatz = -((zeilen.length - 1) * stil.fontSize) / 2
      const tspans = zeilen
        .map((z, i) => `<tspan x="0" dy="${i === 0 ? round(versatz) : stil.fontSize}">${esc(z)}</tspan>`)
        .join('')
      const titel =
        `<g transform="translate(${lane.x + stil.laneTitleW / 2},${lane.y + lane.h / 2}) rotate(-90)">` +
        `<text x="0" y="0" font-family="${esc(stil.fontFamily)},Arial,sans-serif" font-size="${stil.fontSize}" ` +
        `font-weight="bold" fill="${esc(stil.laneLabel)}" text-anchor="middle" ` +
        `dominant-baseline="central">${tspans}</text></g>`
      return (
        `<rect x="${lane.x}" y="${lane.y}" width="${lane.w}" height="${lane.h}" fill="${esc(stil.laneFill)}" ` +
        `stroke="${esc(stil.laneStroke)}" stroke-width="1"/>` +
        `<line x1="${lane.x + stil.laneTitleW}" y1="${lane.y}" x2="${lane.x + stil.laneTitleW}" ` +
        `y2="${lane.y + lane.h}" stroke="${esc(stil.laneStroke)}" stroke-width="1"/>${titel}`
      )
    })
    .join('')

  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]))
  const inner = laneSvg + spec.edges.map((e) => edgeSvg(byId, e)).join('') + boxes.map(boxSvg).join('')
  const cells = [...lanes.map(mxLane), ...boxes.map(mxBox), ...spec.edges.map(mxEdge)]
  return svgWrap(width, height, inner, cells)
}

/** Hausmaße je Knotenart im Flussdiagramm. */
function flowSize(node: FlowNode): { w: number; h: number } {
  if (node.kind === 'decision') return { w: stil.flowDecisionW, h: stil.flowDecisionH }
  if (node.kind === 'terminal') return { w: stil.flowNodeW, h: stil.flowTerminalH }
  return { w: stil.flowNodeW, h: stil.flowNodeH }
}

/**
 * Flussdiagramm — die Koordinaten bleiben beim Agenten.
 *
 * Verzweigungen sauber anzuordnen ist ein eigenes Problem, das ein einfaches
 * Auto-Layout nicht löst; es ist hier ausdrücklich nicht mitgelöst
 * (2026-07-27-mcp-anhaenge-design.md, „Out of Scope").
 */
function generateFlow(spec: FlowSpec): string {
  const boxes: Box[] = spec.nodes.map((node) => {
    const haus = flowSize(node)
    const w = node.w ?? haus.w
    const lines = wrapLabel(node.label, w, stil.fontSize)
    // Bei der Raute steht der Text in der Mitte, wo sie am schmalsten NICHT
    // ist — sie braucht trotzdem mehr Höhe als ein Kasten, sonst ragt der Text
    // in die Spitzen. Deshalb die Zeilen mit Aufschlag statt bündig.
    const mindest = Math.ceil(neededHeight(lines, stil.fontSize) * (node.kind === 'decision' ? 1.6 : 1))
    const h = node.h ?? Math.max(haus.h, mindest)
    return { id: node.id, label: node.label, kind: node.kind, x: node.x, y: node.y, w, h, variant: 'flow', lines }
  })

  const width = Math.round(Math.max(...boxes.map((b) => b.x + b.w)) + 20)
  const height = Math.round(Math.max(...boxes.map((b) => b.y + b.h)) + 20)
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]))
  const inner = spec.edges.map((e) => edgeSvg(byId, e)).join('') + boxes.map(boxSvg).join('')
  const cells = [...boxes.map(mxBox), ...spec.edges.map(mxEdge)]
  return svgWrap(width, height, inner, cells)
}

// --- Schlüssigkeit --------------------------------------------------------

/**
 * Prüft die Beschreibung, BEVOR gezeichnet wird.
 *
 * Eine Verbindung auf einen Schritt, den es nicht gibt, würde beim Zeichnen
 * einen Zugriff auf `undefined` auslösen — der Agent bekäme einen technischen
 * Fehler, aus dem er nicht schließen kann, was er falsch gemacht hat. Die
 * Meldungen hier nennen deshalb den Namen, der nicht aufgeht.
 *
 * Gibt die Liste der Beanstandungen zurück; leer heißt schlüssig.
 */
export function validateDiagram(spec: DiagramSpec): string[] {
  const fehler: string[] = []
  const ids = spec.kind === 'swimlane' ? spec.steps.map((s) => s.id) : spec.nodes.map((n) => n.id)

  if (ids.length === 0) fehler.push('Das Diagramm enthält keine Schritte.')
  const gesehen = new Set<string>()
  for (const id of ids) {
    if (gesehen.has(id)) fehler.push(`Die Kennung "${id}" kommt mehrfach vor — Kennungen müssen eindeutig sein.`)
    gesehen.add(id)
  }

  if (spec.kind === 'swimlane') {
    if (spec.lanes.length === 0) fehler.push('Das Bahnendiagramm hat keine Bahnen.')
    for (const step of spec.steps) {
      if (!Number.isInteger(step.lane) || step.lane < 0 || step.lane >= spec.lanes.length) {
        fehler.push(
          `Schritt "${step.id}" nennt die Bahn ${step.lane}; es gibt die Bahnen 0 bis ${spec.lanes.length - 1}.`,
        )
      }
    }
  }

  for (const edge of spec.edges) {
    if (!gesehen.has(edge.from)) fehler.push(`Die Verbindung von "${edge.from}" nennt einen Schritt, den es nicht gibt.`)
    if (!gesehen.has(edge.to)) fehler.push(`Die Verbindung nach "${edge.to}" nennt einen Schritt, den es nicht gibt.`)
  }

  return fehler
}
