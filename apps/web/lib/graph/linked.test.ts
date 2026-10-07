import { describe, expect, it } from 'vitest'
import { linkedPages, pagesByConnections } from './linked.js'
import type { GraphData, GraphEdgeType } from './types.js'

const node = (id: string, title: string) => ({
  id, title, path: `${id}/index.md`, status: 'released' as const, tags: [], updatedAt: '2026-07-12T00:00:00.000Z',
})
const edge = (from: string, to: string, type: GraphEdgeType = 'link') => ({ from, to, type, label: '' })

describe('linkedPages', () => {
  it('empty graph → two empty groups', () => {
    expect(linkedPages({ nodes: [], edges: [] }, 'a')).toEqual({ linksTo: [], linkedFrom: [] })
  })

  it('centre only → two empty groups', () => {
    expect(linkedPages({ nodes: [node('a', 'A')], edges: [] }, 'a')).toEqual({ linksTo: [], linkedFrom: [] })
  })

  it('A→B and B→A: B appears once in each group', () => {
    const graph: GraphData = { nodes: [node('a', 'A'), node('b', 'B')], edges: [edge('a', 'b'), edge('b', 'a')] }
    expect(linkedPages(graph, 'a')).toEqual({
      linksTo: [{ id: 'b', title: 'B' }],
      linkedFrom: [{ id: 'b', title: 'B' }],
    })
  })

  it('a duplicate edge (link and relation to the same page) counts once', () => {
    const graph: GraphData = {
      nodes: [node('a', 'A'), node('b', 'B')],
      edges: [edge('a', 'b'), edge('a', 'b'), edge('a', 'b', 'relation')],
    }
    expect(linkedPages(graph, 'a').linksTo).toEqual([{ id: 'b', title: 'B' }])
  })

  it('ignores hierarchy and tag edges', () => {
    const graph: GraphData = {
      nodes: [node('a', 'A'), node('b', 'B'), node('c', 'C')],
      edges: [edge('a', 'b', 'hierarchy'), edge('c', 'a', 'tag')],
    }
    expect(linkedPages(graph, 'a')).toEqual({ linksTo: [], linkedFrom: [] })
  })

  it('ignores a self-edge', () => {
    const graph: GraphData = { nodes: [node('a', 'A')], edges: [edge('a', 'a'), edge('a', 'a', 'relation')] }
    expect(linkedPages(graph, 'a')).toEqual({ linksTo: [], linkedFrom: [] })
  })

  it('sorts each group by title', () => {
    const graph: GraphData = {
      nodes: [node('a', 'A'), node('z', 'Zeta'), node('m', 'Mu'), node('b', 'Beta')],
      edges: [edge('a', 'z'), edge('a', 'm'), edge('a', 'b')],
    }
    expect(linkedPages(graph, 'a').linksTo.map((p) => p.title)).toEqual(['Beta', 'Mu', 'Zeta'])
  })
})

describe('pagesByConnections', () => {
  it('orders by distinct neighbours, descending; ties by title', () => {
    const graph: GraphData = {
      nodes: [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Gamma'), node('d', 'Delta')],
      edges: [
        edge('a', 'b'),
        edge('b', 'a'), // same pair again — still one neighbour
        edge('a', 'c', 'relation'),
        edge('d', 'a', 'hierarchy'), // ignored
        edge('d', 'd'), // self-edge ignored
      ],
    }
    expect(pagesByConnections(graph)).toEqual([
      { id: 'a', title: 'Alpha', connections: 2 },
      { id: 'b', title: 'Beta', connections: 1 },
      { id: 'c', title: 'Gamma', connections: 1 },
      { id: 'd', title: 'Delta', connections: 0 },
    ])
  })

  it('empty graph → empty list', () => {
    expect(pagesByConnections({ nodes: [], edges: [] })).toEqual([])
  })
})
