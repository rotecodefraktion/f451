import type { Node as PmNode } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'

// --- Footnotes in the WYSIWYG editor (f451#82) ---------------------------------------
//
// Pure helpers around the two nodes from `@f451/editor`: `footnoteReference` (inline
// atom, `<sup class="fn-ref">`) and `footnoteDefinition` (block, `<div class="fn-def">`).
// No editor instance needed — testable against a plain ProseMirror document. The Tiptap
// wiring (command, shortcut) lives in `ui-extensions.ts`, the click-to-jump handler in
// `wysiwyg-editor.tsx`.

export const FOOTNOTE_REFERENCE = 'footnoteReference'
export const FOOTNOTE_DEFINITION = 'footnoteDefinition'

const NUMERIC_LABEL = /^\d+$/

/** Next free numeric label: the highest purely numeric label of any reference or
 *  definition plus one, `'1'` when there is none. Word labels (`[^note]`) are
 *  ignored — they never collide with a number. */
export function nextFootnoteLabel(doc: PmNode): string {
  let max = 0
  doc.descendants((node) => {
    const name = node.type.name
    if (name === FOOTNOTE_REFERENCE || name === FOOTNOTE_DEFINITION) {
      const label = String(node.attrs.label ?? '')
      if (NUMERIC_LABEL.test(label)) max = Math.max(max, Number.parseInt(label, 10))
      // Definitions may contain references of their own — keep descending.
      return name === FOOTNOTE_DEFINITION
    }
    return true
  })
  return String(max + 1)
}

/** Position of the first node of `typeName` whose label equals `label`; failing
 *  that, the first one whose identifier (or label) matches `identifier ?? label`
 *  case-insensitively — the way mdast normalises footnote identifiers. */
function findByLabel(doc: PmNode, typeName: string, label: string, identifier?: string | null): number | null {
  let exact: number | null = null
  let loose: number | null = null
  const key = (identifier ?? label).toLowerCase()
  doc.descendants((node, pos) => {
    if (exact !== null) return false
    if (node.type.name !== typeName) return true
    const nodeLabel = String(node.attrs.label ?? '')
    if (nodeLabel === label) {
      exact = pos
      return false
    }
    if (loose === null) {
      const nodeIdentifier = node.attrs.identifier as string | null | undefined
      if ((nodeIdentifier ?? nodeLabel).toLowerCase() === key || nodeLabel.toLowerCase() === key) loose = pos
    }
    // A definition may itself contain references, but never another definition.
    return typeName !== FOOTNOTE_DEFINITION
  })
  return exact ?? loose
}

/** Position of the `footnoteDefinition` for `label` (see {@link findByLabel}). */
export function findDefinition(doc: PmNode, label: string, identifier?: string | null): number | null {
  return findByLabel(doc, FOOTNOTE_DEFINITION, label, identifier)
}

/** Position of the first `footnoteReference` for `label` in document order. */
export function findFirstReference(doc: PmNode, label: string, identifier?: string | null): number | null {
  return findByLabel(doc, FOOTNOTE_REFERENCE, label, identifier)
}

/** Whether the schema of `doc` knows both footnote nodes. */
export function supportsFootnotes(doc: PmNode): boolean {
  const { nodes } = doc.type.schema
  return Boolean(nodes[FOOTNOTE_REFERENCE] && nodes[FOOTNOTE_DEFINITION])
}

/** Inserts a new footnote into `tr`: the reference replaces the current selection,
 *  the definition (with one empty paragraph) is appended as the last top-level node,
 *  and the cursor moves into that paragraph. Returns `false` (and leaves `tr`
 *  untouched) when the schema lacks the footnote nodes. Kept here rather than in
 *  the Tiptap command so it is testable on a plain `EditorState`. */
export function insertFootnoteInto(tr: Transaction): boolean {
  if (!supportsFootnotes(tr.doc)) return false
  const { nodes } = tr.doc.type.schema
  const label = nextFootnoteLabel(tr.doc)
  const attrs = { label, identifier: label }

  tr.replaceSelectionWith(nodes[FOOTNOTE_REFERENCE]!.create(attrs), false)

  const definition = nodes[FOOTNOTE_DEFINITION]!.create(attrs, nodes.paragraph!.create())
  const definitionPos = tr.doc.content.size
  tr.insert(definitionPos, definition)
  // definitionPos → opens the definition, +1 → opens the paragraph, +2 → inside it.
  tr.setSelection(TextSelection.create(tr.doc, definitionPos + 2))
  tr.scrollIntoView()
  return true
}
