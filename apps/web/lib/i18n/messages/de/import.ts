/**
 * Namespace "import" — the import/export page of a space (#128):
 * `app/wiki/[space]/(shell)/import/page.tsx` and the client island
 * `components/import-panel.tsx`. The identifier is `importMessages` because
 * `import` is a reserved word; the namespace key in `index.ts` is `import`.
 *
 * `status` labels both the per-page events and the counts of a finished job;
 * a status the API sends that is not listed here is shown verbatim.
 */
export const importMessages = {
  pageTitle: 'Import und Export',
  intro:
    'Übernimmt einen Markdown-Ordner, einen Obsidian-Vault, einen HTML-Ordner, Word-, PowerPoint- und Excel-Dateien oder Inhalte aus BookStack in diesen Space oder schreibt Seiten des Space nach BookStack. Der Lauf geht im Hintergrund weiter, auch wenn diese Seite geschlossen wird.',
  tabsLabel: 'Richtung',
  tabs: {
    import: 'Import',
    export: 'Export',
  },
  originLabel: 'Herkunft',
  origins: {
    bookstack: 'BookStack',
    file: 'Datei',
  },
  fileFormat: 'Format',
  fileFormats: {
    markdown: 'Markdown-Ordner',
    obsidian: 'Obsidian-Vault',
    html: 'HTML-Ordner',
    office: 'Office-Dateien',
  },
  file: 'ZIP-Archiv',
  fileOffice: 'Datei oder ZIP-Archiv',
  fileHint: 'Den Ordner oder Vault als ZIP-Archiv hochladen, höchstens {max} MB.',
  fileHintOffice: 'Eine Word-, PowerPoint- oder Excel-Datei (auch LibreOffice) oder ein ZIP-Archiv davon hochladen, höchstens {max} MB.',
  splitOffice: 'Aufteilen (Kapitel, Folien, Blätter)',
  instance: 'BookStack-Instanz',
  tokenId: 'Token-ID',
  tokenSecret: 'Token-Secret',
  tokenHint: 'Ein API-Token aus deinem BookStack-Profil. Es wird nur für diesen Lauf verwendet und nicht gespeichert.',
  loadBooks: 'Bücher laden',
  loadingBooks: 'Lädt …',
  sourceKind: 'Quelle',
  sourceKinds: {
    book: 'Buch',
    shelf: 'Regal',
    page: 'Einzelne Seite',
  },
  sourceChoose: '— auswählen —',
  bookSlug: 'Buch (Slug)',
  shelfId: 'Regal (ID oder Slug)',
  pageId: 'Seiten-ID in BookStack',
  catalogHint: 'Ohne geladene Bücher lässt sich die Quelle auch von Hand eintragen.',
  parentId: 'Unter Seite (ID, optional)',
  parentIdHint: 'Leer lassen, um an der Wurzel des Space zu importieren.',
  update: 'Bereits importierte Seiten aktualisieren',
  release: 'Seiten direkt freigeben',
  dryRun: 'Probelauf (nichts schreiben, nur berichten)',
  startPageId: 'Ab Seite (ID, optional)',
  startPageIdHint: 'Leer lassen, um den ganzen Space zu exportieren.',
  bookId: 'In bestehendes Buch (ID, optional)',
  bookIdHint: 'Leer lassen, um ein neues Buch anzulegen.',
  start: 'Starten',
  starting: 'Startet …',
  running: 'Läuft …',
  progress: '{done} von {total} Seiten',
  progressUnknown: 'Quelle wird gelesen …',
  /** Shown instead of the page count while a run is in a phase without page
   *  events; `writing` has no entry because the count is shown there. */
  phase: {
    creating: 'Seiten werden in f451 angelegt …',
    reading: 'Seiten werden aus f451 gelesen …',
    placing: 'Seiten werden in BookStack angelegt …',
  },
  eventsLabel: 'Verlauf',
  cancel: 'Abbrechen',
  cancelling: 'Bricht ab …',
  finished: {
    done: 'Abgeschlossen',
    failed: 'Fehlgeschlagen',
    cancelled: 'Abgebrochen',
  },
  countsLabel: 'Ergebnis',
  reportLabel: 'Bericht',
  download: 'Bericht herunterladen',
  newRun: 'Neuer Lauf',
  waitingReviews_one: '{count} Seite wartet im Review auf Freigabe.',
  waitingReviews_other: '{count} Seiten warten im Review auf Freigabe.',
  waitingReviewsLink: 'Zu den offenen Reviews',
  status: {
    created: 'angelegt',
    updated: 'aktualisiert',
    skipped: 'übersprungen',
    failed: 'fehlgeschlagen',
    cancelled: 'abgebrochen',
  },
  errors: {
    missingFields: 'Bitte Instanz, Token-ID, Token-Secret und eine Quelle angeben.',
    invalidNumber: 'Bitte eine ganze Zahl angeben.',
    missingFile: 'Bitte ein ZIP-Archiv auswählen.',
    tooLarge: 'Die Datei ist größer als die erlaubten {max} MB.',
    badArchive: 'Das Archiv wurde abgelehnt.',
    catalogFailed: 'Die Bücher konnten nicht geladen werden.',
    busy: 'Es läuft bereits ein Import oder Export — die Anzeige wechselt zu diesem Lauf.',
    full: 'Gerade laufen zu viele Importe und Exporte. Bitte in ein paar Minuten erneut versuchen.',
    forbidden: 'Kein Schreibrecht für diesen Space.',
    notFound: 'Space nicht gefunden oder kein Zugriff.',
    startFailed: 'Der Lauf konnte nicht gestartet werden.',
    cancelFailed: 'Der Abbruch konnte nicht gesendet werden — bitte erneut versuchen.',
  },
} as const
