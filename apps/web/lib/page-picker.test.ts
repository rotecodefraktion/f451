import { describe, expect, it } from 'vitest'
import { flattenTree, type PickerNode } from './page-picker.js'

const node = (id: string, title: string, children: PickerNode[] = [], archived = false): PickerNode => ({
  id,
  title,
  archived,
  children,
})

const tree: PickerNode[] = [
  node('handbook', 'Handbook', [
    node('overview', '1 Overview', [node('goals', '1.1 Goals')]),
    node('network', '2 Network Access', [node('vpn', '2.1 VPN')]),
    node('legacy', '3 Legacy Setup', [node('legacy-old', '3.1 Old Notes')], true),
    node('glossary', '4 Glossary'),
  ]),
]

describe('flattenTree', () => {
  it('lists pages depth-first in tree order', () => {
    expect(flattenTree(tree).map((o) => o.title)).toEqual([
      'Handbook',
      '1 Overview',
      '1.1 Goals',
      '2 Network Access',
      '2.1 VPN',
      '4 Glossary',
    ])
  })

  it('records the depth of each page', () => {
    expect(flattenTree(tree).map((o) => [o.id, o.depth])).toEqual([
      ['handbook', 0],
      ['overview', 1],
      ['goals', 2],
      ['network', 1],
      ['vpn', 2],
      ['glossary', 1],
    ])
  })

  it('skips archived pages together with their subtree', () => {
    const ids = flattenTree(tree).map((o) => o.id)
    expect(ids).not.toContain('legacy')
    expect(ids).not.toContain('legacy-old')
  })

  it('returns an empty list for an empty tree', () => {
    expect(flattenTree([])).toEqual([])
  })
})
