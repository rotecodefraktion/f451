import { visit } from 'unist-util-visit'

// --- mdast-Transform: GFM-Alerts (Blockquotes mit [!TYP]-Marker) -------------------
//
// `> [!NOTE]\n> Text` wird zu `<div class="alert alert-note"><p class="alert-title">
// </p>Text</div>`. Läuft vor remark-rehype, analog zu remarkResolveLinks in
// render.ts — nutzt data.hName/hProperties, um den blockquote-Knoten in ein div
// umzubiegen, ohne den mdast-Typ selbst zu ändern (das Kind bleibt ein gültiger
// paragraph-Baum für die restliche Transform-Kette).
//
// Der Titel selbst bleibt hier bewusst LEER (Issue #9): Markdown/HTML sind
// sprachneutral gespeicherte Daten, der Titeltext ("Note"/"Hinweis" usw.) folgt der
// UI-Sprache, nicht der Seitensprache, und wird daher erst clientseitig über CSS
// Custom Properties eingeblendet, die `apps/web/app/layout.tsx` aus `lib/i18n`
// setzt (siehe `.alert-<typ>::before { content: var(--label-alert-<typ>) }` in
// `apps/web/app/styles/61-lese.css`/`62-editor.css`). Das `<p class="alert-title">`
// bleibt als Struktur erhalten, damit bestehende Sanitizer-/Editor-Verträge
// (packages/editor/src/nodes/alert.ts) unverändert greifen.

/** Die fünf GFM-Alert-Typen (lowercase — deckt sich mit dem `alertType`-Attribut des
 *  Editor-Schemas, packages/editor/src/nodes/alert.ts). */
export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const MARKER_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/

/** Lokale, minimale Node-Typen statt @types/mdast-Dependency — analog zu render.ts. */
interface MutableNode {
  type: string
  value?: string
  children?: MutableNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

/** Erkennt einen `[!TYP]`-Marker am Anfang eines Textknotens und liefert den Alert-Typ
 *  (lowercase) plus den Rest-Text (Marker samt folgendem Whitespace/Zeilenumbruch
 *  entfernt). undefined, wenn kein Marker erkannt wird. Reine Textfunktion — kennt
 *  keine mdast-Struktur, daher separat von matchAlertBlockquote testbar. */
export function matchAlertMarker(text: string): { alertType: AlertKind; rest: string } | undefined {
  const match = MARKER_PATTERN.exec(text)
  if (!match) return undefined
  const alertType = match[1].toLowerCase() as AlertKind
  const rest = text.slice(match[0].length).replace(/^\s+/, '')
  return { alertType, rest }
}

export interface AlertBlockquoteMatch<T> {
  alertType: AlertKind
  /** Kinder der Blockquote NACH Entfernen des Markers aus dem ersten Absatz (Marker-only-
   *  Absatz wird komplett ausgeschlossen, siehe Kommentar unten) — enthält KEINEN
   *  Titel-Absatz, das ist Sache des jeweiligen Aufrufers (remarkAlerts fügt einen
   *  hast-Titel-Absatz ein, der Editor-Konverter leitet den Titel aus alertType her).
   *  Non-destructiv: node bleibt unverändert, das ist eine neue, flache Kopie-Kette. */
  bodyChildren: readonly T[]
  /** true, wenn der Marker im Quelltext ein EIGENER Absatz war (`> [!NOTE]\n>\n> Text`
   *  — der Marker-Absatz wurde komplett aus bodyChildren gestrichen). Quelltreue-Info
   *  für den Editor-Roundtrip (Phase 2b, Task 4): ohne dieses Flag wären die
   *  Marker-only-Form und die übliche "Marker + Text im selben Absatz"-Form nach dem
   *  Umbau nicht mehr unterscheidbar, docToMarkdown könnte die Ursprungsform nicht
   *  byte-identisch rekonstruieren. remarkAlerts (Render-Pfad) ignoriert das Feld. */
  markerOwnParagraph: boolean
}

/** Minimale Struktur, die matchAlertBlockquote von einem Knoten braucht — generisch
 *  über T, damit sowohl das hast-orientierte MutableNode dieses Moduls (mit data.hName/
 *  hProperties) als auch der Editor-Konverter (packages/editor/src/from-markdown.ts,
 *  eigener, schlankerer mdast-Node-Typ ohne data-Feld) denselben Code nutzen können,
 *  ohne dass eine Seite Felder vortäuschen müsste, die sie nicht hat. */
type AlertNodeLike<T> = T & { type: string; value?: string; children?: readonly T[] }

/** Geteilte Alert-Erkennungslogik: prüft, ob ein mdast-'blockquote'-Knoten mit einem
 *  `[!TYP]`-Marker beginnt, und liefert (non-destruktiv) den Alert-Typ plus die
 *  Blockquote-Kinder nach Marker-Entfernung. Wird sowohl von remarkAlerts (Render-Pfad,
 *  hier) als auch vom Editor-Konverter (packages/editor/src/from-markdown.ts,
 *  mdast -> ProseMirror) genutzt — EINE Implementierung der Marker-only-Absatz-
 *  Behandlung statt zweier abweichender Kopien. */
export function matchAlertBlockquote<T>(node: AlertNodeLike<T>): AlertBlockquoteMatch<T> | undefined {
  if (node.type !== 'blockquote') return undefined
  const children = node.children ?? []
  const firstChild = children[0] as AlertNodeLike<T> | undefined
  if (!firstChild || firstChild.type !== 'paragraph') return undefined

  const paragraphChildren = firstChild.children ?? []
  const firstText = paragraphChildren[0] as AlertNodeLike<T> | undefined
  if (!firstText || firstText.type !== 'text' || typeof firstText.value !== 'string') return undefined

  const matched = matchAlertMarker(firstText.value)
  if (!matched) return undefined
  const { alertType, rest } = matched

  if (rest.length === 0) {
    // Marker-only-Absatz (z. B. "> [!NOTE]\n>\n> Text"): der erste Absatz ist nach
    // Entfernen des Markers leer — komplett aus den Kindern streichen, sonst bliebe ein
    // leeres <p></p> im Output stehen. NUR dieser Zweig setzt markerOwnParagraph: true —
    // im Zweig darunter (Marker-Text leer, aber weitere Inline-Kinder im selben Absatz)
    // stand der Marker zwar allein auf seiner ZEILE, aber nicht in einem eigenen
    // ABSATZ (kein Blank-Line-Trenner im Quelltext).
    const remainingParagraphChildren = paragraphChildren.slice(1)
    if (remainingParagraphChildren.length === 0) {
      return { alertType, bodyChildren: children.slice(1), markerOwnParagraph: true }
    }
    const newFirstChild = { ...firstChild, children: remainingParagraphChildren } as T
    return { alertType, bodyChildren: [newFirstChild, ...children.slice(1)], markerOwnParagraph: false }
  }

  const newFirstText = { ...firstText, value: rest } as T
  const newFirstChild = {
    ...firstChild,
    children: [newFirstText, ...paragraphChildren.slice(1)],
  } as T
  return { alertType, bodyChildren: [newFirstChild, ...children.slice(1)], markerOwnParagraph: false }
}

export function remarkAlerts() {
  return (tree: any): void => {
    visit(tree, 'blockquote', (node: MutableNode) => {
      const matched = matchAlertBlockquote(node)
      if (!matched) return
      const { alertType, bodyChildren } = matched

      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: { className: ['alert', `alert-${alertType}`] },
      }

      // Kein Text-Kind: der Titel ist reine Struktur, der Inhalt kommt aus der
      // UI-Sprache (s. Kopfkommentar). Ein leerer Absatz ohne Kinder ist ein
      // gültiger hast-Baum (rendert zu `<p class="alert-title"></p>`).
      const titleNode: MutableNode = {
        type: 'paragraph',
        children: [],
        data: { hName: 'p', hProperties: { className: ['alert-title'] } },
      }
      node.children = [titleNode, ...bodyChildren]
    })
  }
}
