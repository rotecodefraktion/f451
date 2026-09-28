/**
 * Namespace „graph" — Graph-Ansicht eines Space (Phase 3b/Phase 5 i18n):
 * die Vollbild-Graph-Ansicht (`components/graph/graph-view.tsx`, inkl.
 * Filterbar, Kantentyp-Umschalter, Legende, Detail-Popover, Minitree) sowie
 * der Mini-Graph „Verknüpfte Seiten" in der Leseansicht-Rail
 * (`components/mini-graph.tsx`). Vom Nutzer eingegebene Seitentitel/Tags sind
 * INHALT und bleiben unübersetzt — hier nur das UI-Chrome drumherum.
 */
export const graph = {
  minitree: {
    collapsedAriaLabel: 'Space {name} — eingeklappt',
    spaceTitle: 'Space {name}',
    listView: 'Als Liste anzeigen',
    graphActive: 'Graph-Ansicht (aktiv)',
  },
  filter: {
    placeholder: 'Knoten filtern …',
    ariaLabel: 'Knoten im Graph filtern',
    spaceLabel: 'Space',
    spaceSelectAriaLabel: 'Space auswählen',
    edgeTogglesAriaLabel: 'Kantentypen ein-/ausblenden',
    depthTitle: 'Wie viele Sprünge um die Auswahl herum gezeigt werden',
    depthLabel: 'Tiefe',
    depthAriaLabel: 'Graphtiefe',
    resetTitle: 'Ansicht zurücksetzen',
    reset: 'Zurücksetzen',
  },
  edges: {
    hierarchy: 'Hierarchie',
    link: 'Link',
    relation: 'Relation',
  },
  status: {
    released: 'Released',
    review: 'Review',
    working: 'Working',
    archived: 'Archiviert',
  },
  canvasAriaLabel:
    'Wissensgraph des Space {name}: {count} Seiten als Knoten, nach Status eingefärbt, verbunden durch Hierarchie-, Link- und Relations-Kanten.',
  legend: {
    nodesHeading: 'Knoten · Status',
    edgesHeading: 'Kanten · Typ',
    hierarchyHint: 'enthält',
    linkHint: 'verweist',
    relationHint: 'depends_on …',
  },
  popover: {
    ariaLabel: 'Detail zum Knoten {title}',
    subtitle: 'Space {name} · Seite',
    close: 'Schließen',
    links: 'Verknüpfungen',
    edgeTypes: 'Kantentypen',
    updated: 'Aktualisiert',
    open: 'Öffnen',
  },
  hint: {
    nodes: 'Knoten',
    edges: 'Kanten',
  },
  mini: {
    ariaLabel: 'Mini-Graph verknüpfter Seiten',
  },
} as const
