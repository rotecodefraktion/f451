import { getEditorSchema, markdownToDoc } from '@f451/editor'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { Node as PmNode } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'
import { enterInTableCell, tableGuardPlugin } from './table-guard.js'

// Headless (kein DOM): baut die EditorState direkt aus dem geteilten Editor-Schema
// (@f451/editor) + prosemirror-state, exakt wie im Brief gefordert.

const TABLE_MD = `| A | B |
| --- | --- |
| eins | zwei |
| drei | vier |
`

function stateWithTable(plugins: ReturnType<typeof tableGuardPlugin>[] = []): EditorState {
  const doc = markdownToDoc(TABLE_MD)
  return EditorState.create({ schema: getEditorSchema(), doc, plugins })
}

/** Position des Starts des ERSTEN Textknotens mit exakt diesem Inhalt. */
function findTextPos(doc: PmNode, text: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (found !== -1) return false
    if (node.isText && node.text === text) {
      found = pos
      return false
    }
    return true
  })
  if (found === -1) throw new Error(`Text "${text}" nicht im Dokument gefunden`)
  return found
}

function stateWithCursorAt(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
}

function tableNode(doc: PmNode): PmNode {
  let table: PmNode | undefined
  doc.descendants((node) => {
    if (table) return false
    if (node.type.name === 'table') {
      table = node
      return false
    }
    return true
  })
  if (!table) throw new Error('keine Tabelle im Dokument gefunden')
  return table
}

describe('enterInTableCell', () => {
  it('liefert false außerhalb einer Tabellenzelle (Standard-Enter greift)', () => {
    const doc = markdownToDoc('Ein normaler Absatz.')
    const state = EditorState.create({ schema: getEditorSchema(), doc })
    expect(enterInTableCell(state)).toBe(false)
  })

  it('springt in einer mittleren Zelle zur nächsten Zelle statt den Absatz zu splitten', () => {
    let state = stateWithTable()
    state = stateWithCursorAt(state, findTextPos(state.doc, 'eins') + 2)

    let current = state
    const handled = enterInTableCell(state, (tr) => {
      current = current.apply(tr)
    })

    expect(handled).toBe(true)
    // Kein Split: die "eins"-Zelle enthält weiterhin genau einen Absatz.
    const einsPos = findTextPos(current.doc, 'eins')
    const cellDepth = current.doc.resolve(einsPos).depth - 1
    const cell = current.doc.resolve(einsPos).node(cellDepth)
    expect(cell.type.name).toBe('tableCell')
    expect(cell.childCount).toBe(1)
    // Cursor liegt jetzt in der Zelle mit "zwei".
    expect(current.selection.$from.parent.textContent).toBe('zwei')
  })

  it('fügt in der letzten Zelle eine neue Zeile an und springt in deren erste Zelle', () => {
    let state = stateWithTable()
    state = stateWithCursorAt(state, findTextPos(state.doc, 'vier') + 2)

    let current = state
    const handled = enterInTableCell(state, (tr) => {
      current = current.apply(tr)
    })

    expect(handled).toBe(true)
    // Ursprünglich 3 Zeilen (Header + 2 Body-Zeilen) -> jetzt 4.
    expect(tableNode(current.doc).childCount).toBe(4)
    // "vier" selbst bleibt unangetastet (kein Split).
    const vierPos = findTextPos(current.doc, 'vier')
    const cellDepth = current.doc.resolve(vierPos).depth - 1
    expect(current.doc.resolve(vierPos).node(cellDepth).childCount).toBe(1)
    // Cursor liegt jetzt in der neuen (leeren) ersten Zelle der neuen Zeile.
    expect(current.selection.$from.parent.textContent).toBe('')
  })
})

describe('tableGuardPlugin (filterTransaction)', () => {
  it('lässt gewöhnliche Textänderungen innerhalb einer Zelle unverändert durch', () => {
    const state = stateWithTable([tableGuardPlugin()])
    const pos = findTextPos(state.doc, 'eins') + 4
    const tr = state.tr.insertText('!', pos)
    const next = state.apply(tr)
    expect(next.doc.textContent).toContain('eins!')
  })

  it('verwirft eine Transaktion, die einen zweiten Absatz in eine Zelle einfügt', () => {
    const onCellOverflow = vi.fn()
    const state = stateWithTable([tableGuardPlugin(onCellOverflow)])
    const einsPos = findTextPos(state.doc, 'eins')
    const $eins = state.doc.resolve(einsPos)
    const cellDepth = $eins.depth - 1
    const cellEnd = $eins.end(cellDepth)

    const schema = state.schema
    const secondParagraph = schema.nodes.paragraph!.create({}, schema.text('zweiter Absatz'))
    const tr = state.tr.insert(cellEnd, secondParagraph)

    const next = state.apply(tr)

    expect(next.doc.eq(state.doc)).toBe(true)
    expect(next.doc.textContent).not.toContain('zweiter Absatz')
    expect(onCellOverflow).toHaveBeenCalledOnce()
  })

  it('verwirft eine Transaktion, die einen Nicht-Absatz-Block (Codeblock) in eine Zelle einfügt', () => {
    const state = stateWithTable([tableGuardPlugin()])
    const einsPos = findTextPos(state.doc, 'eins')
    const $eins = state.doc.resolve(einsPos)
    const cellDepth = $eins.depth - 1
    const cellStart = $eins.start(cellDepth)
    const cellEnd = $eins.end(cellDepth)

    const schema = state.schema
    const codeBlock = schema.nodes.codeBlock!.create({}, schema.text('const x = 1'))
    const tr = state.tr.replaceWith(cellStart, cellEnd, codeBlock)

    const next = state.apply(tr)

    expect(next.doc.eq(state.doc)).toBe(true)
  })
})
