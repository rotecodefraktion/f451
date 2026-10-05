import { describe, expect, it } from 'vitest'
import { filterTree, foldForFilter, toFilterNodes, type FilterNode } from './tree-filter.js'

const tree: FilterNode[] = [
  {
    id: 'home',
    title: 'Home',
    children: [
      {
        id: 'ops',
        title: 'Operations',
        children: [
          { id: 'backup', title: 'Backup and Restore', children: [] },
          { id: 'uebersicht', title: 'Übersicht', children: [] },
        ],
      },
      { id: 'cafe', title: 'Café-Regeln', children: [] },
    ],
  },
]

describe('filterTree', () => {
  it('returns null for an empty or whitespace query', () => {
    expect(filterTree(tree, '')).toBeNull()
    expect(filterTree(tree, '   ')).toBeNull()
  })

  it('keeps matching nodes, case-insensitive', () => {
    expect(filterTree(tree, 'RESTORE')?.has('backup')).toBe(true)
  })

  it('keeps all ancestors of a match and nothing else', () => {
    expect(filterTree(tree, 'restore')).toEqual(new Set(['backup', 'ops', 'home']))
  })

  it('returns an empty set when nothing matches', () => {
    expect(filterTree(tree, 'nonexistent')).toEqual(new Set())
  })

  it('folds umlauts and diacritics in both title and query', () => {
    expect(filterTree(tree, 'ubersicht')?.has('uebersicht')).toBe(true)
    expect(filterTree(tree, 'Über')?.has('uebersicht')).toBe(true)
    expect(filterTree(tree, 'cafe')?.has('cafe')).toBe(true)
  })

  it('keeps a matching parent without its non-matching children', () => {
    expect(filterTree(tree, 'operations')).toEqual(new Set(['ops', 'home']))
  })
})

describe('foldForFilter', () => {
  it('strips combining marks and lowercases', () => {
    expect(foldForFilter('Ärger É')).toBe('arger e')
  })
})

describe('toFilterNodes', () => {
  it('drops everything but id, title and children', () => {
    const input = [{ id: 'a', title: 'A', path: 'a.md', archived: false, hasChildren: false, children: [] }]
    expect(toFilterNodes(input)).toEqual([{ id: 'a', title: 'A', children: [] }])
  })
})
