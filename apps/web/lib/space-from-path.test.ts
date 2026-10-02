import { describe, expect, it } from 'vitest'
import { spaceFromPath } from './space-from-path.js'
import { wikiPageEditHref, wikiPageHref, wikiSpaceHref } from './urls.js'

describe('spaceFromPath', () => {
  it('reads the space of a wiki page', () => {
    expect(spaceFromPath('/wiki/demo/p-overview')).toBe('demo')
  })

  it('reads the space of a space root and of nested space routes', () => {
    expect(spaceFromPath('/wiki/demo')).toBe('demo')
    expect(spaceFromPath('/wiki/demo/p-overview/edit')).toBe('demo')
    expect(spaceFromPath('/wiki/demo/p-overview/review')).toBe('demo')
    expect(spaceFromPath('/wiki/demo/p-overview/versions')).toBe('demo')
    expect(spaceFromPath('/wiki/demo/graph')).toBe('demo')
  })

  it('has no space on the wiki root', () => {
    expect(spaceFromPath('/wiki')).toBeNull()
    expect(spaceFromPath('/wiki/')).toBeNull()
  })

  it('decodes an encoded space id (round trip with the href helpers)', () => {
    const space = 'team a/ops:1'
    expect(spaceFromPath(wikiSpaceHref(space))).toBe(space)
    expect(spaceFromPath(wikiPageHref(space, 'path:a/b.md'))).toBe(space)
    expect(spaceFromPath(wikiPageEditHref(space, 'p'))).toBe(space)
  })

  it('has no space outside the wiki', () => {
    expect(spaceFromPath('/')).toBeNull()
    expect(spaceFromPath('/settings')).toBeNull()
    expect(spaceFromPath('/wikis/demo')).toBeNull()
  })

  it('ignores a trailing slash', () => {
    expect(spaceFromPath('/wiki/demo/')).toBe('demo')
    expect(spaceFromPath('/wiki/demo/p-overview/')).toBe('demo')
  })

  it('returns null for a malformed encoding instead of throwing', () => {
    expect(spaceFromPath('/wiki/%E0%A4%A')).toBeNull()
  })
})
