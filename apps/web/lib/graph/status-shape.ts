import type { GraphNodeStatus } from './types'

/**
 * FORM je Workflow-Status — das farbfreie zweite Merkmal des Graph-Knotens.
 *
 * Warum es das gibt: Bis Teilschritt I unterschieden sich die Knotenpunkte der
 * Zustände `working`, `review` und `released` AUSSCHLIESSLICH in Füllung und
 * Ringfarbe; nur `archived` hatte mit `opacity: 0.6` ein zweites Merkmal. Für
 * Sehende mit Farbsinnstörung waren damit drei der vier Zustände auf der Fläche
 * ununterscheidbar — ein Bruch der zugesicherten Eigenschaft 3 der
 * Erscheinungsbild-Spec („Statusfarben tragen immer zusätzlich Zeichen und
 * Wort", `docs/superpowers/specs/2026-07-26-erscheinungsbild-2026-design.md`).
 * Gemeldet als Befund 5 im Bericht H5, s. Dateiende von
 * `app/styles/65-graph.css`.
 *
 * Warum Form und nicht Zeichen: Der Punkt ist 18 px groß (r = 9, `nodeRadius`
 * in `components/graph/graph-view.tsx`). Die vier Zeichen des Marken-Bausteins
 * (`◔ ◑ ✓ ▤`, s. `app/styles/42-marke.css`) sind bei dieser Kantenlänge nicht
 * mehr auseinanderzuhalten — die Silhouetten Kreis / Raute / Dreieck / Quadrat
 * dagegen schon, und sie brauchen keinen zweiten Farbwert, dessen Kontrast
 * gegen vier Statusfüllungen in Hell UND Dunkel zu halten wäre.
 *
 * Warum als eigenes, reines Modul und nicht inline im Bauteil: So ist die
 * Unterscheidbarkeit prüfbar (`status-shape.test.ts`) und die LEGENDE zeichnet
 * beweisbar dieselben Formen wie die Fläche — eine Legende, die ein anderes
 * Merkmal zeigt als der Knoten, erklärt nichts.
 *
 * Alle Formen stehen im Kreis mit Radius `r`, damit die `nodeRadius`-abhängige
 * Geometrie des Bauteils (Beschriftungsabstand, Auswahl-Halo) unverändert
 * weiterrechnet.
 */
export type StatusShape =
  /** `<circle r>` */
  | { readonly kind: 'circle'; readonly r: number }
  /** `<path d>` */
  | { readonly kind: 'path'; readonly d: string }

const round = (value: number) => Math.round(value * 100) / 100

export function statusShape(status: GraphNodeStatus, r: number): StatusShape {
  switch (status) {
    case 'released':
      return { kind: 'circle', r }
    case 'review':
      // Raute: Quadrat auf der Spitze, Ecken auf dem Umkreis.
      return { kind: 'path', d: `M0 ${round(-r)}L${round(r)} 0L0 ${round(r)}L${round(-r)} 0Z` }
    case 'working': {
      // Gleichseitiges Dreieck, Spitze oben (Ecken bei 0°/120°/240° auf dem
      // Umkreis). Optisch leichter als der Kreis, deshalb 12 % größer gerechnet
      // — bei gleichem r wirkte es merklich kleiner als die drei anderen.
      const t = r * 1.12
      return {
        kind: 'path',
        d: `M0 ${round(-t)}L${round(t * 0.866)} ${round(t * 0.5)}L${round(-t * 0.866)} ${round(t * 0.5)}Z`,
      }
    }
    case 'archived': {
      // Achsenparalleles Quadrat. Halbe Seite 0,8 r ergibt annähernd die Fläche
      // des Kreises (2,56 r² gegen 3,14 r²) bei gleicher Höhe wie die Raute.
      const s = round(r * 0.8)
      return { kind: 'path', d: `M${-s} ${-s}H${s}V${s}H${-s}Z` }
    }
  }
}
