import { mergeAttributes, Node } from '@tiptap/core'

// --- Eigener Inline-Node: Wikilink ([[ziel]] / [[ziel|alias]]) ---------------------
//
// Wichtige Einschränkung (siehe Task-2b2-Report, Abschnitt Concerns): render.ts löst
// Wikilinks VOR dem Rendern zu HTML auf (remarkResolveLinks in packages/markdown/src/
// render.ts) — ein AUFGELÖSTER Wikilink wird dort zu einem ganz gewöhnlichen
// `<a href="…">text</a>` ohne jede unterscheidbare Markierung (kein eigenes class-
// oder data-Attribut), ein NICHT auflösbarer zu `<span class="broken-link">text</span>`.
// Die Lese-Pipeline kennt an der HTML-Oberfläche also gar keine dauerhaft
// unterscheidbare "Wikilink"-Markierung, weil die Auflösung (Seite existiert? welche
// URL?) ausserhalb des Editor-Schemas liegt (Backend-Lookup). Ein 1:1-Spiegeln dieser
// beiden Fälle ist daher nicht möglich, ohne die Zielauflösung selbst im Editor
// nachzubilden (out of scope für Task 2).
//
// Entscheidung: Der Node rendert als <a> (konsistent mit dem, was ein aufgelöster
// Wikilink im Lese-HTML tatsächlich ist — ein Anchor, kein Span), trägt aber
// zusätzlich `data-wiki-link`/`data-target`/`data-alias`, damit parseHTML den Node
// beim Einfügen von Editor-eigenem HTML (Copy/Paste innerhalb des Editors, Yjs-Sync
// über renderHTML/parseHTML-Fallbacks) verlustfrei zurückgewinnt. Die Konverter
// (Task 3/4) sind dafür zuständig, echte mdast-'wikiLink'-Knoten <-> diesen
// PM-Node zu übersetzen; HTML-Copy/Paste aus der reinen Leseansicht (ohne die
// data-Attribute) fällt mangels Markierung auf einen normalen Link zurück — das ist
// eine bewusste, dokumentierte Lücke, kein Versehen.

export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-target') ?? '',
        renderHTML: (attrs) => ({ 'data-target': attrs.target }),
      },
      alias: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-alias'),
        renderHTML: (attrs) => (attrs.alias ? { 'data-alias': attrs.alias } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-wiki-link]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const text = (node.attrs.alias as string | null) ?? (node.attrs.target as string)
    return [
      'a',
      mergeAttributes(HTMLAttributes, { 'data-wiki-link': '', class: 'wiki-link' }),
      text,
    ]
  },
})
