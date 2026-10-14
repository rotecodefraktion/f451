import { describe, expect, it } from 'vitest'
import { afterRelease, releaseBody, waitingReviews, type ReviewItem } from './reviews-state.js'

function item(id: string): ReviewItem {
  return {
    id,
    title: `Title ${id}`,
    path: `${id}.md`,
    isNew: false,
    lastAuthor: null,
    updatedAt: '2026-10-15T10:00:00.000Z',
    prNumber: 1,
    prUrl: 'https://git.example/pr/1',
  }
}

describe('releaseBody', () => {
  it('sends nothing in an unversioned space', () => {
    expect(releaseBody(false, 'major', 'some note')).toEqual({})
  })

  it('sends bump and the trimmed note in a versioned space', () => {
    expect(releaseBody(true, 'minor', '  fixed typos ')).toEqual({ bump: 'minor', note: 'fixed typos' })
  })

  it('leaves a blank note out', () => {
    expect(releaseBody(true, 'patch', '   ')).toEqual({ bump: 'patch' })
  })
})

describe('afterRelease', () => {
  it('removes a released row and deselects it', () => {
    const items = [item('a'), item('b')]
    const next = afterRelease(items, new Set(['a', 'b']), 'a', { ok: true })
    expect(next.items.map((i) => i.id)).toEqual(['b'])
    expect([...next.selected]).toEqual(['b'])
    expect(next.result).toEqual({ state: 'idle' })
  })

  it('failure keeps the row selected', () => {
    const items = [item('a'), item('b')]
    const next = afterRelease(items, new Set(['a', 'b']), 'a', { ok: false, reason: 'conflict' })
    expect(next.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(next.selected.has('a')).toBe(true)
    expect(next.result).toEqual({ state: 'failed', reason: 'conflict' })
  })

  it('does not mutate the input selection', () => {
    const selected = new Set(['a'])
    afterRelease([item('a')], selected, 'a', { ok: true })
    expect(selected.has('a')).toBe(true)
  })
})

describe('waitingReviews', () => {
  it('counts only events that link to a review', () => {
    expect(waitingReviews([{ link: 'review' }, { link: 'page' }, {}, { link: 'review' }])).toBe(2)
    expect(waitingReviews([])).toBe(0)
  })
})
