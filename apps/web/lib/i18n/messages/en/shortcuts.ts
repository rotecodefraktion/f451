import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/shortcuts.ts`. */
export const shortcuts: Messages['shortcuts'] = {
  dialogAriaLabel: 'Keyboard shortcuts',
  title: 'Keyboard shortcuts',
  groups: {
    view: 'View',
    search: 'Search',
    help: 'Help',
  },
  view: {
    nav: 'Toggle the page tree',
    rail: 'Toggle the info panel',
    full: 'Full width (both panels closed)',
  },
  search: {
    keys: '⌘K / Ctrl+K',
    open: 'Open search',
  },
  help: {
    overview: 'This overview',
    close: 'Close',
  },
}
