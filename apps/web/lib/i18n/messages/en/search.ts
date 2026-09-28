import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/search.ts`. */
export const search: Messages['search'] = {
  dialogAriaLabel: 'Search',
  inputAriaLabel: 'Search term',
  resultsAriaLabel: 'Search results',
  idle: 'Type to search across all spaces.',
  loading: 'Searching …',
  error: 'Search is currently unavailable — please try again later.',
  noResults: 'No matches for "{query}".',
}
