/**
 * Namespace „sidebar" — Seitenbaum-Kopfzeile + Werkzeugliste im Space-Layout
 * (`app/wiki/[space]/(shell)/layout.tsx`).
 *
 * Plural-Konvention (siehe `lib/i18n/format.ts`): `pageCount` existiert NUR
 * als `pageCount_one`/`pageCount_other`-Paar, nie als eigener Basis-Schlüssel
 * — `t()` wählt die passende Variante über `{count}` selbst aus.
 *
 * Jedes Werkzeug führt `label` (die Zeile) und `desc` (den Erklärsatz
 * darunter). Die Reihenfolge der Schlüssel ist die Anzeigereihenfolge in der
 * Leiste, gruppiert nach `toolGroups`.
 */
export const sidebar = {
  treeAriaLabel: 'Seiten im Space {space}',
  pageCount_one: '{count} Seite',
  pageCount_other: '{count} Seiten',
  spaceLabel: 'Space',
  pagesGroup: 'Seiten',
  empty: 'Noch keine Seiten.',
  toolGroups: {
    find: 'Finden',
    configure: 'Einrichten',
    help: 'Hilfe',
  },
  tools: {
    search: {
      label: 'Suche',
      desc: 'Volltext über alle Seiten dieses Bereichs.',
    },
    graph: {
      label: 'Graph-Ansicht',
      desc: 'Zeigt als Netz, welche Seiten aufeinander verweisen.',
    },
    report: {
      label: 'Verweis-Report',
      desc: 'Findet tote Verweise und Seiten, auf die niemand zeigt.',
    },
    templates: {
      label: 'Vorlagen',
      desc: 'Startpunkte für neue Seiten, mit vorgegebenem Aufbau.',
    },
    schema: {
      label: 'Metadaten-Schema',
      desc: 'Legt fest, welche Zusatzfelder die Seiten führen.',
    },
    connections: {
      label: 'Verbindungen',
      desc: 'Zugänge für KI-Agenten verwalten.',
    },
    appearance: {
      label: 'Erscheinungsbild',
      desc: 'Farben, Schriften und Abstände einstellen.',
    },
    shortcuts: {
      label: 'Tastenkürzel',
      desc: 'Alle Tastenkürzel im Überblick.',
    },
  },
} as const
