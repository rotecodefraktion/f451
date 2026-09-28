import { mergeAttributes, Node } from '@tiptap/core'

// --- Eigener Block-Node: GFM-Alert (5 Typen) ---------------------------------------
//
// Bildet `> [!NOTE] …` (und die vier weiteren Marker) als eigenständigen Node ab —
// NICHT als Blockquote mit Zusatzattribut, weil ein Alert semantisch ein anderes
// Konstrukt ist als ein Zitat (eigener Titel, eigene Typen). Die Konverter (Task 3/4)
// entscheiden, wie ein mdast-'blockquote'-Knoten mit [!TYP]-Marker (siehe
// packages/markdown/src/alerts.ts) auf diesen Node abgebildet wird.
//
// Titel-Text ("Hinweis", "Tipp", …) ist bewusst NICHT Teil von `content` — er wird aus
// alertType hergeleitet (wie in alerts.ts), aber NICHT im Editor-DOM gerendert (s.
// renderHTML/Issue-#22-Kommentar unten): rein visuell per CSS `::before` auf
// `.alert-<typ>` eingeblendet (apps/web/app/globals.css). Die Leseansicht (Server,
// packages/markdown/src/render.ts) rendert den Titel weiterhin als echtes
// `<p class="alert-title">`; dessen deutsche Strings ("Hinweis", "Tipp", "Wichtig",
// "Warnung", "Achtung") sind die kanonische Quelle, die globals.css spiegeln muss —
// hier nicht dupliziert, weil renderHTML sie seit dem Fix nicht mehr braucht. content
// bildet nur den eigentlichen Alert-Body ab (block+, wie im Auftrag gefordert).

export type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const ALERT_TYPES: readonly AlertType[] = ['note', 'tip', 'important', 'warning', 'caution']

function isAlertType(value: unknown): value is AlertType {
  return typeof value === 'string' && (ALERT_TYPES as readonly string[]).includes(value)
}

/** Liest den Alert-Typ aus der Klassenliste eines `div.alert.alert-<typ>`-Elements
 *  (exaktes Markup aus render.ts/alerts.ts: `class="alert alert-note"` usw.). */
function alertTypeFromElement(element: HTMLElement): AlertType | false {
  for (const cls of element.classList) {
    const match = /^alert-(note|tip|important|warning|caution)$/.exec(cls)
    if (match) return match[1] as AlertType
  }
  return false
}

export const Alert = Node.create({
  name: 'alert',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      // parseHTML/renderHTML dieses Attributs bleiben hier bewusst leer: Das
      // Alert-Markup kodiert den Typ als Teil einer zusammengesetzten Klasse
      // (`alert alert-<typ>`), nicht als eigenes Attribut — das muss auf Node-Ebene
      // gelesen werden (siehe getAttrs in parseHTML()/renderHTML() unten), nicht pro
      // Attribut. Ohne diese Overrides würde Tiptap sonst nach einer eigenen
      // `data-alert-type`-Notation suchen, die es im gelesenen HTML nicht gibt.
      alertType: {
        default: 'note' satisfies AlertType,
        parseHTML: () => undefined,
        renderHTML: () => ({}),
      },
      // Reine Quelltreue-Info für den Markdown-Roundtrip (Task 4, to-markdown.ts):
      // true, wenn der [!TYP]-Marker im Quelltext ein EIGENER Absatz war
      // ("> [!NOTE]\n>\n> Text" statt "> [!NOTE]\n> Text") — matchAlertBlockquote
      // streicht diesen Marker-Absatz beim Einlesen komplett, ohne das Flag wäre die
      // Ursprungsform beim Zurückschreiben nicht byte-identisch rekonstruierbar
      // (Abnahme-Kriterium: kompletter Golden-Korpus roundtrippt byte-identisch).
      // Bewusst OHNE HTML-Repräsentation (parseHTML/renderHTML leer): die Form ist
      // für Darstellung und Editieren bedeutungslos, nur die Serialisierung liest sie;
      // JSON-serialisierbar (boolean) für Yjs/toJSON ist sie trotzdem.
      markerOwnParagraph: {
        default: false,
        parseHTML: () => undefined,
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div.alert',
        getAttrs: (element) => {
          const type = alertTypeFromElement(element)
          return type ? { alertType: type } : false
        },
        // Der Titel-<p> ist reine Darstellung (aus alertType hergeleitet) — beim
        // Parsen wird er NICHT als Content-Kind übernommen, sonst würde er als
        // editierbarer Absatz im Dokument landen. Tiptaps contentElement erlaubt,
        // ein anderes Element als Content-Quelle zu bestimmen als das Match selbst.
        contentElement: (element) => {
          const withoutTitle = element.cloneNode(true) as HTMLElement
          withoutTitle.querySelector('p.alert-title')?.remove()
          return withoutTitle
        },
      },
    ]
  },

  // WICHTIG (Issue #22): Das Content-Loch (`0`) muss laut ProseMirrors
  // `DOMSerializer.renderSpec` das ALLEINIGE Kind seines Eltern-Arrays sein — sobald
  // ein Geschwister-Eintrag danebensteht (hier war es das statische Titel-<p>), wirft
  // renderSpec beim Mounten "Content hole must be the only child of its parent node".
  // Der Alert-Node hat `content: 'block+'`, ein Titel-<p> als Geschwister crashte
  // daher JEDEN Editor-Mount mit einer Alert-Node im Dokument (z.B. den `> [!NOTE]`
  // im Seed). Der Titel wird deshalb NICHT mehr als DOM-Kind gerendert, sondern rein
  // visuell per CSS `::before` auf `.alert-<typ>` eingeblendet (s. globals.css) — der
  // Titel-Text ist ohnehin kein editierbarer Inhalt (s. Kommentar oben), nur
  // Darstellung. `parseHTML.contentElement` oben bleibt unverändert: Die
  // Leseansicht/der Server rendern weiterhin ein echtes `<p class="alert-title">`
  // (s. packages/markdown/src/render.ts), das hier beim Einlesen entfernt wird.
  renderHTML({ node, HTMLAttributes }) {
    const alertType = isAlertType(node.attrs.alertType) ? node.attrs.alertType : 'note'
    return ['div', mergeAttributes(HTMLAttributes, { class: `alert alert-${alertType}` }), 0]
  },
})
