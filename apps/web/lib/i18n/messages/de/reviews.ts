/**
 * Namespace "reviews" — the review overview of a space (#131):
 * `app/wiki/[space]/(shell)/reviews/page.tsx` and the client island
 * `components/reviews-list.tsx`. Not to be confused with `review`, the
 * review view of a single page.
 */
export const reviews = {
  pageTitle: 'Offene Reviews',
  intro: 'Alle Entwürfe dieses Space, die auf Freigabe warten. Ausgewählte Reviews werden nacheinander freigegeben.',
  count_one: '{count} offenes Review',
  count_other: '{count} offene Reviews',
  forbidden: 'Die Review-Übersicht steht nur Personen mit Schreibrecht für diesen Space zur Verfügung.',
  loadFailed: 'Die offenen Reviews konnten nicht geladen werden.',
  empty: 'Keine offenen Reviews.',
  tableLabel: 'Offene Reviews',
  selectAll: 'Alle auswählen',
  selectRow: '{title} auswählen',
  columns: {
    title: 'Seite',
    kind: 'Art',
    author: 'Zuletzt bearbeitet von',
    updated: 'Geändert',
  },
  kinds: {
    new: 'neu',
    changed: 'geändert',
  },
  unknownAuthor: '—',
  bump: 'Versionssprung',
  bumps: {
    major: 'Major',
    minor: 'Minor',
    patch: 'Patch',
  },
  note: 'Notiz zur Freigabe (optional)',
  releaseSelected: 'Ausgewählte freigeben ({count})',
  releasing: 'Wird freigegeben …',
  released_one: '{count} Seite freigegeben.',
  released_other: '{count} Seiten freigegeben.',
  errors: {
    conflict: 'Der Entwurf wurde zwischenzeitlich geändert — bitte das Review öffnen.',
    forbidden: 'Kein Schreibrecht für diesen Space.',
    releaseFailed: 'Die Freigabe ist fehlgeschlagen.',
    network: 'Der Server ist nicht erreichbar.',
  },
} as const
