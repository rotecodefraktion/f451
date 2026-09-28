import Image from '@tiptap/extension-image'

/**
 * Bild-Node unseres Markdown-Dialekts: das Stock-`@tiptap/extension-image`
 * (src/alt/title) ergänzt um `width`/`height`.
 *
 * Die Maße stammen aus dem Obsidian-Suffix `![Alt|400](url)` bzw. `![Alt|400x300]`
 * — from-/to-markdown (packages/editor) parsen/serialisieren sie über
 * `parseImageAltSize`/`formatImageAlt` (@f451/markdown, dieselbe Quelle wie die
 * Lese-Pipeline). Als echte Node-Attribute werden sie im Editor als `<img width
 * height>` gerendert (Anzeige der Breite) und sind die Datenbasis für die
 * interaktiven Resize-Griffe der Editor-NodeView (apps/web).
 *
 * `parseHTML`/`renderHTML` der Attribute betreffen nur die Editor-HTML-Fidelity
 * (Copy/Paste): ein eingefügtes `<img width="400">` behält seine Breite. Der
 * Markdown-Roundtrip läuft NICHT über HTML, sondern über die Konverter, die die
 * Attribute direkt setzen/lesen.
 */
export const EditorImage = Image.extend({
  addAttributes() {
    const parseDimension = (value: string | null): number | null => {
      if (!value) return null
      const n = Number.parseInt(value, 10)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => parseDimension(element.getAttribute('width')),
        renderHTML: (attributes) => (attributes.width ? { width: attributes.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (element) => parseDimension(element.getAttribute('height')),
        renderHTML: (attributes) => (attributes.height ? { height: attributes.height } : {}),
      },
    }
  },
})
