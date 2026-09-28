import { diagrammStil as stil, mxStil } from '@f451/design-tokens'

/**
 * Formenbibliothek „Hausstil" für den draw.io-Editor (MCP-Anhänge, Paket 6).
 *
 * ERZEUGT aus denselben Stil-Zeichenketten wie der Diagramm-Generator des
 * MCP-Dienstes (`@f451/design-tokens`, `diagram.ts`), nicht von Hand gepflegt:
 * Ändert jemand einen Diagramm-Token, zieht ein Mensch aus der Bibliothek
 * dieselben Kästen, die ein Agent erzeugt (Spec, User Story 21).
 *
 * Format: Konfiguration `libraries` des Editors
 * (https://www.drawio.com/docs/reference/configure-diagram-editor), jede Form
 * ein mxGraphModel als XML samt Maßen.
 *
 * Sichtbar wird ein solcher Eintrag erst, wenn seine ID in der Liste der
 * angezeigten Bibliotheken steht (`Sidebar.showEntries` prüft die Einträge
 * aus `libraries` gegen `mxSettings.libraries`, Vorgabe `defaultLibraries`).
 * `defaultCustomLibraries` ist dafür der FALSCHE Schlüssel — er nennt
 * Bibliotheks-DATEIEN, nicht diese Einträge (am ausgelieferten draw.io-Code
 * nachgelesen, nachdem die Abnahme #76 die Bibliothek nicht fand).
 */

/** draw.io-Vorgabe der angezeigten Bibliotheken (`Sidebar.prototype.defaultEntries`),
 *  mit dem Hausstil vorneweg — die eingebauten Formen bleiben. */
const DRAWIO_STANDARD_BIBLIOTHEKEN = 'general;uml;er;bpmn;flowchart;basic;arrows2'

export const HAUSSTIL_BIBLIOTHEK_ID = 'f451-hausstil'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Eine Form als eigenständiges mxGraphModel. */
function form(titel: string, style: string, w: number, h: number, beschriftung = titel) {
  const xml =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    `<mxCell id="2" value="${esc(beschriftung)}" style="${esc(style)}" vertex="1" parent="1">` +
    `<mxGeometry width="${w}" height="${h}" as="geometry"/></mxCell></root></mxGraphModel>`
  return { xml, w, h, title: titel }
}

/** Die Formen in der Reihenfolge, in der man sie beim Zeichnen braucht. */
export function hausstilFormen(sprache: 'de' | 'en' = 'de') {
  const de = sprache === 'de'
  return [
    form(de ? 'Anfang/Ende' : 'Start/End', mxStil.anfangEnde, stil.laneStepW, stil.laneStepH, de ? 'Start' : 'Start'),
    form(de ? 'Schritt (Bahnen)' : 'Step (lanes)', mxStil.schritt('swimlane'), stil.laneStepW, stil.laneStepH, de ? 'Schritt' : 'Step'),
    form(de ? 'Schritt (Fluss)' : 'Step (flow)', mxStil.schritt('flow'), stil.flowNodeW, stil.flowNodeH, de ? 'Schritt' : 'Step'),
    form(de ? 'Entscheidung' : 'Decision', mxStil.entscheidung, stil.flowDecisionW, stil.flowDecisionH, de ? 'Frage?' : 'Question?'),
    form(de ? 'Bahn' : 'Lane', mxStil.bahn, stil.laneStepW * 4, stil.laneH, de ? 'Rolle' : 'Role'),
  ]
}

/** Kurzer, stabiler Fingerabdruck (djb2) — kein Sicherheitszweck. */
function fingerabdruck(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Die `config` für die Antwort auf das `configure`-Ereignis des Editors.
 *
 * `version`: draw.io verwirft gespeicherte Editor-Einstellungen, wenn ihre
 * `configVersion` nicht zur Konfiguration passt (`mxSettings.parse`), und legt
 * sie aus den Vorgaben neu an — erst dadurch greift `defaultCustomLibraries`
 * auch bei jemandem, der den Editor schon einmal geöffnet hatte. Die Version
 * ist ein Fingerabdruck der Formen: Sie ändert sich genau dann, wenn sich ein
 * Diagramm-Token ändert. Preis: In diesem Moment gehen die persönlichen
 * draw.io-Einstellungen (zuletzt genutzte Farben u. ä.) einmal verloren.
 */
export function drawioKonfiguration(sprache: 'de' | 'en' = 'de'): Record<string, unknown> {
  const bibliotheken = `${HAUSSTIL_BIBLIOTHEK_ID};${DRAWIO_STANDARD_BIBLIOTHEKEN}`
  return {
    // Die Liste gehört mit in den Fingerabdruck: Ändert sie sich, müssen
    // gespeicherte Editor-Einstellungen (mit der alten Liste) verworfen werden.
    version: `f451-hausstil-${fingerabdruck(JSON.stringify([hausstilFormen('de'), bibliotheken]))}`,
    libraries: [
      {
        title: { main: 'f451' },
        entries: [
          {
            id: HAUSSTIL_BIBLIOTHEK_ID,
            title: { main: 'Hausstil', en: 'House style' },
            desc: {
              main: 'Formen im Hausstil — dieselben, die der Diagramm-Generator zeichnet.',
              en: 'Shapes in the house style — the same the diagram generator draws.',
            },
            libs: [{ title: { main: 'Hausstil', en: 'House style' }, data: hausstilFormen(sprache) }],
          },
        ],
      },
    ],
    defaultLibraries: bibliotheken,
  }
}
