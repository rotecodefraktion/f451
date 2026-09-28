import type { Extensions } from '@tiptap/core'
import Blockquote from '@tiptap/extension-blockquote'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Italic from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
// @tiptap/extension-bullet-list/-ordered-list/-list-item/-task-list/-task-item sind ab
// v3.27 nur noch dünne Re-Export-Shims auf @tiptap/extension-list (verifiziert im
// installierten dist/index.js) — direkt von dort importieren, statt fünf zusätzliche
// (peer-abhängige) Shim-Pakete zu installieren.
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import Paragraph from '@tiptap/extension-paragraph'
import Strike from '@tiptap/extension-strike'
// Ebenso @tiptap/extension-table-row/-header/-cell: reine Shims auf
// @tiptap/extension-table — dieselbe Begründung wie bei den Listen-Paketen oben.
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import Text from '@tiptap/extension-text'
import { Alert } from './nodes/alert.js'
import { EditorImage } from './nodes/image.js'
import { WikiLink } from './nodes/wiki-link.js'
import { YoutubeEmbed } from './nodes/youtube-embed.js'

// --- Das Extension-Set unseres Markdown-Dialekts -----------------------------------
//
// Bewusst KEIN @tiptap/starter-kit: StarterKit bündelt zusätzlich History, Dropcursor,
// Gapcursor und (je nach Version) weitere UX-Extensions, die nichts mit dem
// Markdown-Dialekt zu tun haben und die für die spätere Tiptap-Yjs-Integration (Phase
// 2c) sogar kontraproduktiv wären (History konkurriert mit Yjs' eigenem Undo-Manager,
// siehe y-prosemirror). Stattdessen: jede Extension einzeln, exakt der im Auftrag
// festgelegte Dialekt-Umfang — nichts mehr, nichts weniger.
//
// KEINE Extensions außerhalb des Dialekts: kein Underline/TextAlign/Color/Highlight
// (Markdown kann sie nicht ausdrücken, YAGNI). Die einzige Ausnahme ist die
// GFM-Tabellen-Alignment (siehe unten) — die IST Teil des Dialekts (`:--`/`:-:`/`--:`
// in der Markdown-Syntax), deshalb ein gezieltes `align`-Attribut auf TableCell/
// TableHeader statt der generischen TextAlign-Extension (die beliebige Blöcke
// beträfe, nicht nur Tabellenzellen — genau das, was der Auftrag ausschliesst).

/** GFM-Tabellen-Alignment: render.ts (packages/markdown/src/render.ts, über
 *  mdast-util-to-hast) erzeugt für `:--`/`:-:`/`--:`-Spalten ein `align`-Attribut auf
 *  `<th>`/`<td>` (kein `style="text-align:…"`) — empirisch gegen renderHtml()
 *  verifiziert. Tiptap 3.27 bringt auf TableCell/TableHeader zwar bereits ein
 *  eingebautes align-Attribut mit (Default null; parseHTML liest style.textAlign UND
 *  das align-Attribut — deckt das Lese-HTML also schon ab), rendert es aber als
 *  `style="text-align:…"`. Dieses Override behält das eingebaute Attribut (samt seinem
 *  toleranteren parseHTML) und ersetzt NUR renderHTML, damit das Editor-Markup exakt
 *  dem der Lese-Pipeline entspricht (Copy/Paste-Konsistenz, wie bei alert). Bewusst
 *  keine generische TextAlign-Extension — die operiert auf beliebigen Blöcken und
 *  würde Konstrukte ausdrücken, die der Markdown-Dialekt nicht kennt.
 */
function withAlignAttribute<T extends typeof TableCell | typeof TableHeader>(extension: T) {
  return extension.extend({
    addAttributes() {
      const parent = this.parent?.() ?? {}
      return {
        ...parent,
        align: {
          ...(parent as Record<string, object>).align,
          renderHTML: (attrs: { align?: string | null }) =>
            attrs.align ? { align: attrs.align } : {},
        },
      }
    },
  })
}

export function editorExtensions(): Extensions {
  return [
    // Fundament (Document/Paragraph/Text) -------------------------------------------
    Document,
    Paragraph,
    Text,

    // Überschriften 1–6 --------------------------------------------------------------
    Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),

    // Inline-Marks: Bold/Italic/Strikethrough/Inline-Code/Links ----------------------
    Bold,
    Italic,
    Strike,
    Code,
    // `literal`-Attr unterscheidet GFM-Autolink-Literale (nackte URL im Text) von
    // regulären `[text](url)`-Links — für die Konverter (Task 3/4) relevant, damit
    // die kanonische Markdown-Form (siehe stringify.ts) beim Roundtrip erhalten
    // bleibt. Auf HTML-Ebene gibt es dafür bewusst KEIN sichtbares Markup (render.ts
    // erzeugt für beide Fälle denselben `<a href>`, siehe wiki-link.ts-Kommentar für
    // dieselbe Einschränkung bei Wikilinks) — `data-literal` dient nur der internen
    // Editor-HTML-Fidelity (Copy/Paste innerhalb des Editors), nicht dem Abgleich mit
    // der Lese-Pipeline.
    Link.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          literal: {
            default: false,
            parseHTML: (element) => element.getAttribute('data-literal') === 'true',
            renderHTML: (attrs) => (attrs.literal ? { 'data-literal': 'true' } : {}),
          },
        }
      },
    }),

    // Bilder (src/alt/title + width/height aus dem `|400`-Suffix) ----------------------
    EditorImage,

    // Listen: Bullet/Ordered (nativ verschachtelbar über den Content-Ausdruck von
    // ListItem: 'paragraph block*' schliesst weitere Listen als Kind-Blöcke ein) ------
    BulletList,
    OrderedList,
    ListItem,

    // Task-Listen (verschachtelt: nested: true) ---------------------------------------
    TaskList,
    TaskItem.configure({ nested: true }),

    // Tabellen (GFM, Alignment) --------------------------------------------------------
    Table,
    TableRow,
    withAlignAttribute(TableHeader),
    withAlignAttribute(TableCell),

    // Codeblöcke mit Sprache (Attr `language`, Default-Verhalten der Extension) -------
    CodeBlock,

    // Blockquotes (normales Zitat — Alerts sind ein eigener Node, siehe unten) --------
    Blockquote,

    // Horizontale Linie, harte Umbrüche ------------------------------------------------
    HorizontalRule,
    HardBreak,

    // Eigene Nodes: GFM-Alerts, Wikilinks und YouTube-Embeds ---------------------------
    Alert,
    WikiLink,
    YoutubeEmbed,
  ]
}
