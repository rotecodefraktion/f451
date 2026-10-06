import { mergeAttributes, Node } from '@tiptap/core'

// --- Block node: GFM footnote definition (`[^label]: …`) ------------------------------
//
// Stays where it sits in the source (mdast keeps definitions in document order), so a
// definition placed before its reference round-trips unchanged. `isolating` keeps
// Backspace/Delete at the edges from merging the note body into neighbouring blocks.
//
// Issue #22: the content hole `0` must be the only child of the render spec. The label
// is therefore not rendered as a DOM child; apps/web draws it via CSS from the
// `data-footnote-def` attribute.

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-footnote-def') ?? '',
        renderHTML: (attrs) => ({ 'data-footnote-def': attrs.label }),
      },
      identifier: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-footnote-id'),
        renderHTML: (attrs) => (attrs.identifier ? { 'data-footnote-id': attrs.identifier } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-footnote-def]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'fn-def' }), 0]
  },
})
