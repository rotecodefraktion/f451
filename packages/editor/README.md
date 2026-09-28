# @f451/editor

Der headless ProseMirror/Tiptap-Kern des WYSIWYG-Editors (Phase 2b): Schema,
Markdown&harr;ProseMirror-Konverter und die Validierungs-API, die vor dem
Moduswechsel prüft, ob ein Dokument verlustfrei editierbar ist. Kein DOM, keine
`EditorView` — die gesamte Test-Suite läuft in Node-vitest ohne jsdom (der
Yjs-Pfad der Editor-UI in Phase 2c bleibt dadurch unverbaut, keine
nicht-JSON-serialisierbaren Attribute).

**Eine Markdown-Wahrheit:** Dieses Paket hat KEINE eigene Markdown-Parse- oder
Stringify-Konfiguration. Parsen läuft über `parseMarkdownTree`, Serialisieren
über `stringifyMarkdown` — beide aus `@f451/markdown` (derselbe geteilte
remark-Prozessor wie Lese-Pipeline und Indexer). Kein `markdown-it`, kein
zweiter `remark`-Aufbau hier.

## API

- **`getEditorSchema(): Schema`** — baut das ProseMirror-Schema des
  Markdown-Dialekts (`editorExtensions()`, s. u.) auf. Grundlage für
  `markdownToDoc`/`docToMarkdown` und die spätere Tiptap-Instanz der Editor-UI
  (`useEditor`/`new Editor({ extensions: editorExtensions() })`).
- **`editorExtensions(): Extensions`** — das Tiptap-Extension-Set: Document,
  Paragraph, Text, Heading (1–6), Bold/Italic/Strike/Code, Link (mit
  `literal`-Attribut für GFM-Autolink-Literale), Image (block-level),
  Bullet-/Ordered-/Task-Listen, Tabellen mit Spalten-Alignment, CodeBlock,
  Blockquote, HorizontalRule, HardBreak sowie zwei eigene Nodes: `Alert`
  (GFM-Alerts, 5 Typen) und `WikiLink`. Bewusst **kein** `@tiptap/starter-kit`
  (bündelt History/Dropcursor/Gapcursor — History konkurriert mit Yjs' eigenem
  Undo-Manager, Phase 2c) und keine Extensions außerhalb des Markdown-Dialekts
  (kein Underline/TextAlign/Color/Highlight).
- **`markdownToDoc(body: string): PmNode`** — wandelt Markdown-Body-Text
  (Frontmatter bereits abgetrennt, s. `splitFrontmatter`) in ein
  ProseMirror-Dokument um. Wirft `UnsupportedMarkdownError` beim ersten nicht
  abbildbaren Knoten.
- **`docToMarkdown(doc: PmNode): string`** — die Inverse: ProseMirror-Dokument
  zu Markdown-Text, über `stringifyMarkdown` aus `@f451/markdown`.
- **`collectUnsupported(tree: MdastRoot): UnsupportedFinding[]`** — nicht
  werfende Sammel-Traversierung: liefert JEDEN nicht abbildbaren mdast-Knoten
  als `{ type, line }`, statt beim ersten Fund abzubrechen. Grundlage für
  `checkEditorSupport` (s. u.).
- **`UnsupportedMarkdownError`** — `{ nodeType, line }`, geworfen von
  `markdownToDoc`.
- **`checkEditorSupport(markdown: string): EditorSupportReport`** — die
  Validierungs-API dieses Pakets, siehe nächster Abschnitt.

## Roundtrip-Garantie

`docToMarkdown(markdownToDoc(body))` ist für den gesamten Golden-Korpus aus
`@f451/markdown` (`packages/markdown/test/fixtures/canonical/`) **byte-identisch**
zum Original — bewiesen in `test/roundtrip.test.ts`, inklusive aller 5
GFM-Alert-Typen, `.drawio.svg`-Bildlinks und nackter Autolink-Literale
(URLs/YouTube-Zeilen). Frontmatter übersteht `splitFrontmatter`/
`joinFrontmatter` unabhängig davon byte-identisch (Task 1,
`@f451/markdown`) — der Editor rührt es nicht an.

Kanonische Eingaben (Bullet `-`, ATX-Headings, `*kursiv*`/`**fett**`, …)
bleiben beim Roundtrip unverändert. Nicht-kanonische, aber unterstützte
Eingaben werden dabei **normalisiert** (nicht verworfen):

- `*`/`+`-Bullets &rarr; `-`
- Setext-Headings (`Titel\n=====`) &rarr; ATX (`# Titel`)
- `_kursiv_` &rarr; `*kursiv*`
- ein Bild mitten in einem Textabsatz &rarr; eigener Block (Bilder sind in
  diesem Schema `group: 'block'`, s. `from-markdown.ts`)

## Nicht unterstützte Syntax

Diese fünf mdast-Knotentypen lassen sich nicht auf das Editor-Schema abbilden
(`markdownToDoc` wirft, `checkEditorSupport` meldet sie als `unsupported`):

- rohes HTML (Block **und** Inline, `html`)
- Fußnoten-Referenzen (`footnoteReference`)
- Fußnoten-Definitionen (`footnoteDefinition`)
- Referenz-Definitionen (`[label]: /url`, `definition`)
- Referenz-Links/-Bilder (`[Text][label]`/`![Alt][label]`, `linkReference`/
  `imageReference`)

Ein Dokument mit einem dieser Konstrukte kann weiterhin im **Roh-Text-Modus**
bearbeitet werden — nur der WYSIWYG-Moduswechsel wird verweigert (s. u.).

## Validierungs-Vertrag: `checkEditorSupport`

Schutz vor stillem Verlust (Spec): Syntax, die der Editor nicht darstellen
kann, wird **vor** dem Moduswechsel gemeldet, nicht erst beim Zurückschreiben
bemerkt. Validierung heißt **warnen und Verlust verhindern, nicht blockieren**
— nur `unsupported` verweigert den WYSIWYG-Wechsel, alles andere ist eine
Warnung bei weiterhin möglichem Editieren.

```ts
import { checkEditorSupport } from '@f451/editor'

const report = checkEditorSupport(markdown) // volles Dokument, inkl. Frontmatter
// report: { canEdit: boolean; findings: SupportFinding[]; canonicalBody?: string }
```

`markdown` ist das **volle** Dokument (inklusive optionalem Frontmatter) —
`checkEditorSupport` trennt es intern per `splitFrontmatter` ab.
`canonicalBody` ist, wenn gesetzt, NUR der Body (ohne Frontmatter),
roundtrip-stabil: ein erneuter Aufruf von `checkEditorSupport(canonicalBody)`
liefert keine weiteren Findings mehr.

`SupportFinding`:

```ts
interface SupportFinding {
  kind: 'unsupported' | 'normalization' | 'frontmatter'
  message: string
  line?: number // nur bei 'unsupported'
  nodeType?: string // nur bei 'unsupported'
}
```

| `kind`          | Bedeutung                                                                              | `canEdit` | `canonicalBody` |
| --------------- | --------------------------------------------------------------------------------------- | --------- | ---------------- |
| `unsupported`   | Rohes HTML, Fußnoten, Referenz-Links/-Bilder/-Definitionen — nicht abbildbar.            | `false`   | nie gesetzt       |
| `normalization` | Roundtrip verändert Bytes (andere Bullets, Setext-Headings, …), aber alles ist abbildbar. | `true`    | gesetzt           |
| `frontmatter`   | Schemafehler aus `parsePage` (z. B. `"tags: muss eine Liste von Strings sein"`).         | `true`    | nie gesetzt       |

**`unsupported` dominiert:** Liegt auch nur ein einziger nicht abbildbarer
Knoten vor, ist `canEdit: false` — unabhängig von etwaigen
`frontmatter`-Findings (Kombinationsfall, s. Tests). Der Report ist immer die
**vollständige** Befundliste (alle nicht abbildbaren Knoten mit Zeile, alle
Frontmatter-Fehler) — `checkEditorSupport` bricht nie beim ersten Fund ab.

## Tests

```sh
pnpm --filter @f451/editor test
pnpm --filter @f451/editor typecheck
```

Reine Modellebene, kein DOM/jsdom — `checkEditorSupport`/`markdownToDoc`/
`docToMarkdown` arbeiten ausschließlich mit `prosemirror-model` und
`@f451/markdown`.
