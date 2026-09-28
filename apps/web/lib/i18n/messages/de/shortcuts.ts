/**
 * Namespace „shortcuts" — Inhalt des Tastenkürzel-Dialogs
 * (`components/shortcuts-dialog.tsx`).
 *
 * Die Beschreibungen sind absichtlich wortgleich zu den Titeln der beiden
 * Daumenregister (`shell.panes.*.title`, s. `messages/de/shell.ts`) gehalten,
 * nur ohne den dort angehängten Tastenhinweis — die Taste steht hier in einer
 * eigenen Spalte.
 *
 * `search.keys` ist übersetzt, weil die Modifikatortaste ausgeschrieben
 * verschieden heißt („Strg" gegen „Ctrl"). Beide Belegungen stehen
 * nebeneinander statt plattformabhängig gewählt zu werden: eine
 * Betriebssystem-Erkennung wäre für sechs Zeilen Übersicht mehr Apparat als
 * Nutzen, und der Topbar-Trigger zeigt ohnehin fest `⌘K`.
 */
export const shortcuts = {
  dialogAriaLabel: 'Tastenkürzel',
  title: 'Tastenkürzel',
  groups: {
    view: 'Ansicht',
    search: 'Suchen',
    help: 'Hilfe',
  },
  view: {
    nav: 'Seitenbaum ein- und ausklappen',
    rail: 'Info-Leiste ein- und ausklappen',
    full: 'Volle Breite (beide Leisten zu)',
  },
  search: {
    keys: '⌘K / Strg+K',
    open: 'Suche öffnen',
  },
  help: {
    overview: 'Diese Übersicht',
    close: 'Schließen',
  },
} as const
