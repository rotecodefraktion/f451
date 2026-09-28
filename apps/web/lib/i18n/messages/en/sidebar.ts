import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/sidebar.ts`. */
export const sidebar: Messages['sidebar'] = {
  treeAriaLabel: 'Pages in space {space}',
  pageCount_one: '{count} page',
  pageCount_other: '{count} pages',
  spaceLabel: 'Space',
  pagesGroup: 'Pages',
  empty: 'No pages yet.',
  toolGroups: {
    find: 'Find',
    configure: 'Configure',
    help: 'Help',
  },
  tools: {
    search: {
      label: 'Search',
      desc: 'Full text across all pages in this space.',
    },
    graph: {
      label: 'Graph view',
      desc: 'Shows as a network which pages link to each other.',
    },
    report: {
      label: 'Link report',
      desc: 'Finds broken links and pages nothing points to.',
    },
    templates: {
      label: 'Templates',
      desc: 'Starting points for new pages, with a preset structure.',
    },
    schema: {
      label: 'Metadata schema',
      desc: 'Defines which extra fields pages carry.',
    },
    connections: {
      label: 'Connections',
      desc: 'Manage access for AI agents.',
    },
    appearance: {
      label: 'Appearance',
      desc: 'Adjust colours, fonts and spacing.',
    },
    shortcuts: {
      label: 'Keyboard shortcuts',
      desc: 'All keyboard shortcuts at a glance.',
    },
  },
}
