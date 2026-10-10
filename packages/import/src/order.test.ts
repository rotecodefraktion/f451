import { describe, expect, it } from 'vitest'
import { flattenTree } from './order.js'
import type { ImportNode } from './model.js'

const n = (id: string, order: number, children: ImportNode[] = []): ImportNode =>
  ({ sourceRef: { type: 't', id }, title: id, markdown: '', tags: [], children, media: [], order })

describe('flattenTree', () => {
  it('yields parents before children, siblings by order', () => {
    const tree = { root: [n('b', 2), n('a', 1, [n('a2', 2), n('a1', 1)])], droppedHtml: {}, drawingsAsPng: [], failed: [], mediaSkipped: [] }
    expect(flattenTree(tree).map((e) => [e.node.sourceRef.id, e.parent?.sourceRef.id ?? null])).toEqual([
      ['a', null], ['a1', 'a'], ['a2', 'a'], ['b', null],
    ])
  })
})
