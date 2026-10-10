import { describe, expect, it } from 'vitest'
import type { TreeNode } from '../../api.js'
import { planBook } from './tree.js'

const node = (id: string, title: string, children: TreeNode[] = [], path = `${id}/index.md`): TreeNode =>
  ({ id, title, path, archived: false, children })

describe('planBook', () => {
  it('maps folders to chapters and flattens deeper levels with a path prefix', () => {
    const roots = [
      node('root', 'Space', [], 'index.md'),
      node('a', 'A', [node('a1', 'A1'), node('b', 'B', [node('c', 'C', [node('d', 'D')])])]),
      node('x', 'X'),
    ]
    const book = planBook(roots, { bookName: 'Space' })
    expect(book.rootPageId).toBe('root')
    expect(book.pages.map((p) => p.name)).toEqual(['Space', 'X'])
    expect(book.chapters).toHaveLength(1)
    expect(book.chapters[0].pages.map((p) => p.name)).toEqual(['A', 'A1', 'B', 'B / C', 'B / C / D'])
  })

  it('accepts the API shape where the root page index.md holds the top level as children', () => {
    const roots = [
      node('root', 'Space', [
        node('a', 'A', [node('a1', 'A1'), node('b', 'B', [node('c', 'C', [node('d', 'D')])])]),
        node('x', 'X'),
      ], 'index.md'),
    ]
    const book = planBook(roots, { bookName: 'Space' })
    expect(book.rootPageId).toBe('root')
    expect(book.pages.map((p) => [p.name, p.priority])).toEqual([['Space', 0], ['X', 20]])
    expect(book.chapters.map((c) => [c.name, c.priority])).toEqual([['A', 10]])
    expect(book.chapters[0].pages.map((p) => [p.pageId, p.name, p.priority])).toEqual([
      ['a', 'A', 0],
      ['a1', 'A1', 10],
      ['b', 'B', 20],
      ['c', 'B / C', 30],
      ['d', 'B / C / D', 40],
    ])
  })

  it('skips archived pages', () => {
    const roots = [node('a', 'A', [{ ...node('a1', 'A1'), archived: true }, node('a2', 'A2')])]
    const book = planBook(roots, { bookName: 'S' })
    expect(book.rootPageId).toBeNull()
    expect(book.chapters[0].pages.map((p) => p.name)).toEqual(['A', 'A2'])
  })

  it('uses the subtree root as book when startPageId is set', () => {
    const roots = [node('a', 'A', [node('a1', 'A1', [node('a1x', 'A1X')]), node('a2', 'A2')]), node('z', 'Z')]
    const book = planBook(roots, { bookName: 'A', startPageId: 'a' })
    expect(book.rootPageId).toBe('a')
    expect(book.pages.map((p) => p.name)).toEqual(['A', 'A2'])
    expect(book.chapters.map((c) => c.name)).toEqual(['A1'])
    expect(book.chapters[0].pages.map((p) => p.name)).toEqual(['A1', 'A1X'])
  })

  it('finds the start page below the root page index.md', () => {
    const roots = [node('root', 'Space', [node('a', 'A', [node('a1', 'A1')])], 'index.md')]
    const book = planBook(roots, { bookName: 'A', startPageId: 'a' })
    expect(book.rootPageId).toBe('a')
    expect(book.pages.map((p) => p.name)).toEqual(['A', 'A1'])
    expect(book.chapters).toEqual([])
  })

  it('throws when the start page is not in the tree', () => {
    expect(() => planBook([node('a', 'A')], { bookName: 'S', startPageId: 'nope' })).toThrow(/nope/)
  })
})
