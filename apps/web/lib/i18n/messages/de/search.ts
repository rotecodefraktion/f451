/**
 * Namespace „search" — Inhalt des ⌘K-Suchdialogs (`components/search-dialog.tsx`).
 * Der Topbar-TRIGGER (Placeholder-Text im geschlossenen Zustand, Kurzform
 * „Suchen", Tastenkürzel-Badge) ist bereits Phase-1-Umfang und lebt im
 * `shell.search`-Namespace (`messages/de/shell.ts`) — der Dialog-Eingabe-
 * Placeholder ist textidentisch und referenziert deshalb bewusst denselben
 * Key (`t('shell.search.placeholder')`), statt ihn hier zu duplizieren.
 */
export const search = {
  dialogAriaLabel: 'Suche',
  inputAriaLabel: 'Suchbegriff',
  resultsAriaLabel: 'Suchergebnisse',
  idle: 'Tippe, um in allen Spaces zu suchen.',
  loading: 'Suche läuft …',
  error: 'Die Suche ist derzeit nicht erreichbar — bitte später erneut versuchen.',
  noResults: 'Keine Treffer für „{query}“.',
} as const
