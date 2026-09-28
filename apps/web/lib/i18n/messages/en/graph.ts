/** Englisches Gegenstück zu `messages/de/graph.ts` (gleiche Struktur, siehe
 *  dortiger Kommentar). */
import type { Messages } from '../../types.js'

export const graph: Messages['graph'] = {
  minitree: {
    collapsedAriaLabel: 'Space {name} — collapsed',
    spaceTitle: 'Space {name}',
    listView: 'Show as list',
    graphActive: 'Graph view (active)',
  },
  filter: {
    placeholder: 'Filter nodes …',
    ariaLabel: 'Filter nodes in the graph',
    spaceLabel: 'Space',
    spaceSelectAriaLabel: 'Select space',
    edgeTogglesAriaLabel: 'Show/hide edge types',
    depthTitle: 'How many hops around the selection are shown',
    depthLabel: 'Depth',
    depthAriaLabel: 'Graph depth',
    resetTitle: 'Reset view',
    reset: 'Reset',
  },
  edges: {
    hierarchy: 'Hierarchy',
    link: 'Link',
    relation: 'Relation',
  },
  status: {
    released: 'Released',
    review: 'Review',
    working: 'Working',
    archived: 'Archived',
  },
  canvasAriaLabel:
    'Knowledge graph of space {name}: {count} pages as nodes, coloured by status, connected by hierarchy, link and relation edges.',
  legend: {
    nodesHeading: 'Nodes · Status',
    edgesHeading: 'Edges · Type',
    hierarchyHint: 'contains',
    linkHint: 'references',
    relationHint: 'depends_on …',
  },
  popover: {
    ariaLabel: 'Detail for node {title}',
    subtitle: 'Space {name} · Page',
    close: 'Close',
    links: 'Connections',
    edgeTypes: 'Edge types',
    updated: 'Updated',
    open: 'Open',
  },
  hint: {
    nodes: 'nodes',
    edges: 'edges',
  },
  mini: {
    ariaLabel: 'Mini graph of linked pages',
  },
}
