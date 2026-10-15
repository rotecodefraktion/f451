/** English counterpart of `messages/de/reviews.ts`. */
import type { Messages } from '../../types.js'

export const reviews: Messages['reviews'] = {
  pageTitle: 'Open reviews',
  intro: 'All drafts of this space that wait for release. Selected reviews are released one after the other.',
  count_one: '{count} open review',
  count_other: '{count} open reviews',
  forbidden: 'The review overview is only available to people with write access to this space.',
  loadFailed: 'The open reviews could not be loaded.',
  empty: 'No open reviews.',
  tableLabel: 'Open reviews',
  selectAll: 'Select all',
  selectRow: 'Select {title}',
  columns: {
    title: 'Page',
    kind: 'Kind',
    author: 'Last edited by',
    updated: 'Changed',
  },
  kinds: {
    new: 'new',
    changed: 'changed',
    deletion: 'will be deleted',
  },
  unknownAuthor: '—',
  bump: 'Version bump',
  bumps: {
    major: 'Major',
    minor: 'Minor',
    patch: 'Patch',
  },
  note: 'Release note (optional)',
  releaseSelected: 'Release selected ({count})',
  releasing: 'Releasing …',
  released_one: '{count} page released.',
  released_other: '{count} pages released.',
  errors: {
    conflict: 'The draft has changed in the meantime — please open the review.',
    forbidden: 'No write permission for this space.',
    releaseFailed: 'The release failed.',
    network: 'The server cannot be reached.',
  },
}
