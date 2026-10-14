import { describe, expect, it } from 'vitest'
import { importEventLink } from '../src/import/run.js'

/** Where an imported page can be opened right after the run (#128): a page
 *  without release exists only as a draft with an open review. */
describe('importEventLink', () => {
  const noRelease = { release: false, dryRun: false }
  const release = { release: true, dryRun: false }

  it('created or updated without release → the open review', () => {
    expect(importEventLink({ status: 'created', pageId: 'p-a' }, noRelease)).toBe('review')
    expect(importEventLink({ status: 'updated', pageId: 'p-a' }, noRelease)).toBe('review')
  })
  it('created or updated with release → the page', () => {
    expect(importEventLink({ status: 'created', pageId: 'p-a' }, release)).toBe('page')
  })
  it('skipped: open review → review, anything else is published → page', () => {
    expect(importEventLink({ status: 'skipped', pageId: 'p-a', reason: 'already imported, review still open' }, release)).toBe('review')
    expect(importEventLink({ status: 'skipped', pageId: 'p-a', reason: 'already imported' }, noRelease)).toBe('page')
    expect(importEventLink({ status: 'skipped', pageId: 'p-a', reason: 'unchanged' }, noRelease)).toBe('page')
  })
  it('no link for dry runs, failed or cancelled pages, or without a page id', () => {
    expect(importEventLink({ status: 'created', pageId: 'dry-3' }, { release: false, dryRun: true })).toBeUndefined()
    expect(importEventLink({ status: 'failed', pageId: 'p-a' }, noRelease)).toBeUndefined()
    expect(importEventLink({ status: 'cancelled', pageId: 'p-a' }, noRelease)).toBeUndefined()
    expect(importEventLink({ status: 'created' }, noRelease)).toBeUndefined()
  })
})
