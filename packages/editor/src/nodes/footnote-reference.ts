import { mergeAttributes, Node } from '@tiptap/core'

// --- Inline node: GFM footnote reference (`[^label]`) ---------------------------------
//
// An atom: the reference is a pointer to a definition, not editable text. `label` is
// the label as written in the source (round-trips byte-identically, e.g. `[^A]`);
// `identifier` is the normalised mdast identifier that links it to its definition
// (`a` for both `[^A]` and `[^a]:`). A reference created in the editor may carry only
// a label — to-markdown.ts then derives the identifier (footnote-label.ts).

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-footnote-ref') ?? '',
        renderHTML: (attrs) => ({ 'data-footnote-ref': attrs.label }),
      },
      identifier: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-footnote-id'),
        renderHTML: (attrs) => (attrs.identifier ? { 'data-footnote-id': attrs.identifier } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'sup[data-footnote-ref]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: 'fn-ref' }), node.attrs.label as string]
  },
})
