import { getEditorSchema, markdownToDoc } from '@f451/editor'
import type { Node as PmNode } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { findDefinition, findFirstReference, insertFootnoteInto, nextFootnoteLabel } from './footnotes.js'

// Headless: plain ProseMirror documents from the shared editor schema (@f451/editor).

const schema = getEditorSchema()

function ref(label: string, identifier: string | null = label) {
  return { type: 'footnoteReference', attrs: { label, identifier } }
}

function def(label: string, text: string, identifier: string | null = label) {
  return {
    type: 'footnoteDefinition',
    attrs: { label, identifier },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function paragraph(...content: object[]) {
  return { type: 'paragraph', content }
}

function docOf(...content: object[]): PmNode {
  return schema.nodeFromJSON({ type: 'doc', content })
}

describe('nextFootnoteLabel', () => {
  it('returns "1" for a document without footnotes', () => {
    expect(nextFootnoteLabel(docOf(paragraph({ type: 'text', text: 'Plain text.' })))).toBe('1')
  })

  it('continues after the highest numeric label', () => {
    const doc = docOf(paragraph({ type: 'text', text: 'A' }, ref('1'), ref('2')), def('1', 'one'), def('2', 'two'))
    expect(nextFootnoteLabel(doc)).toBe('3')
  })

  it('ignores word labels', () => {
    const doc = docOf(paragraph({ type: 'text', text: 'A' }, ref('note'), ref('1')), def('note', 'n'), def('1', 'one'))
    expect(nextFootnoteLabel(doc)).toBe('2')
  })

  it('counts a label that only has a definition', () => {
    const doc = docOf(paragraph({ type: 'text', text: 'A' }, ref('1')), def('1', 'one'), def('4', 'orphan'))
    expect(nextFootnoteLabel(doc)).toBe('5')
  })
})

describe('findDefinition / findFirstReference', () => {
  const doc = docOf(
    paragraph({ type: 'text', text: 'A' }, ref('Note', 'note'), { type: 'text', text: ' B' }, ref('1')),
    def('1', 'one'),
    def('note', 'word'),
  )

  it('finds the definition by label', () => {
    const pos = findDefinition(doc, '1')
    expect(pos).not.toBeNull()
    expect(doc.nodeAt(pos!)?.attrs.label).toBe('1')
  })

  it('falls back to case-insensitive identifier equality', () => {
    const pos = findDefinition(doc, 'Note', 'note')
    expect(pos).not.toBeNull()
    expect(doc.nodeAt(pos!)?.attrs.label).toBe('note')
  })

  it('finds the first reference', () => {
    const pos = findFirstReference(doc, '1')
    expect(pos).not.toBeNull()
    expect(doc.nodeAt(pos!)?.type.name).toBe('footnoteReference')
    expect(doc.nodeAt(pos!)?.attrs.label).toBe('1')
  })

  it('returns null for an unknown label', () => {
    expect(findDefinition(doc, 'missing')).toBeNull()
    expect(findFirstReference(doc, 'missing')).toBeNull()
  })
})

describe('insertFootnoteInto', () => {
  const TABLE_MD = `| A | B |
| --- | --- |
| eins | zwei |
`

  function textPos(doc: PmNode, text: string): number {
    let found = -1
    doc.descendants((node, pos) => {
      if (found !== -1) return false
      if (node.isText && node.text === text) {
        found = pos
        return false
      }
      return true
    })
    if (found === -1) throw new Error(`text "${text}" not found`)
    return found
  }

  it('puts the reference into the table cell and the definition last at top level', () => {
    const doc = markdownToDoc(`${TABLE_MD}\nAfter the table.\n`)
    let state = EditorState.create({ schema, doc })
    // Cursor at the end of "eins".
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, textPos(state.doc, 'eins') + 4)))

    const tr = state.tr
    expect(insertFootnoteInto(tr)).toBe(true)
    const next = state.apply(tr)

    const refPos = findFirstReference(next.doc, '1')
    expect(refPos).not.toBeNull()
    const $ref = next.doc.resolve(refPos!)
    const ancestors = Array.from({ length: $ref.depth + 1 }, (_, depth) => $ref.node(depth).type.name)
    expect(ancestors.some((name) => name === 'tableCell' || name === 'tableHeader')).toBe(true)

    const last = next.doc.lastChild!
    expect(last.type.name).toBe('footnoteDefinition')
    expect(last.attrs).toMatchObject({ label: '1', identifier: '1' })
    expect(last.firstChild?.type.name).toBe('paragraph')

    // The cursor sits inside the new definition's paragraph.
    expect(next.selection.$from.parent.type.name).toBe('paragraph')
    expect(next.selection.$from.node(next.selection.$from.depth - 1).type.name).toBe('footnoteDefinition')
  })
})
