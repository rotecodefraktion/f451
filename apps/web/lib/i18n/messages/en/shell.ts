import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/shell.ts` — Shape wird über
 *  `Messages['shell']` (abgeleitet aus DE) erzwungen. */
export const shell: Messages['shell'] = {
  meta: {
    title: 'f451 — Documentation platform',
  },
  topbar: {
    homeAriaLabel: 'Go to homepage',
  },
  themeToggle: {
    title: 'Toggle light/dark mode',
    ariaLabel: 'Toggle theme',
  },
  panes: {
    nav: {
      label: 'Page tree',
      title: 'Collapse or expand the page tree (key [ )',
    },
    rail: {
      label: 'Info sidebar',
      title: 'Collapse or expand the info sidebar (key ] )',
    },
  },
  phoneBar: {
    ariaLabel: 'Sections',
    nav: 'Pages',
    toc: 'Outline',
    info: 'Info',
    next: 'Next',
    nextTitle: 'Go to the next page in the page tree',
    close: 'Close',
  },
  langSwitcher: {
    title: 'Change language',
    ariaLabel: 'Change language',
    menuAriaLabel: 'Choose language',
    locales: {
      de: 'German',
      en: 'English',
    },
  },
  spaceSwitcher: {
    menuAriaLabel: 'Switch space',
  },
  account: {
    menuAriaLabel: 'Account menu',
    settingsLabel: 'Settings',
    settingsSubtitle: 'Manage connections',
    logout: 'Log out',
    loggingOut: 'Logging out …',
  },
  search: {
    placeholder: 'Search pages, spaces, people …',
    short: 'Search',
  },
}
