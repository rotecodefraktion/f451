/**
 * Namespace „read" — Leseansicht einer Wiki-Seite (Phase 3): Toolbar/Subbar/
 * Notices in `components/page-view.tsx`, rechte Info-Leiste `components/rail.tsx`,
 * YouTube-Embed-Titel `components/page-body.tsx` sowie die Fehlerkarte in
 * `app/wiki/[space]/(shell)/[pageId]/page.tsx`. Der gerenderte Markdown-
 * SEITENINHALT selbst (`data.html`) ist NICHT Teil dieses Namespace — nur das
 * UI-Chrome drumherum.
 *
 * Plural-Konvention (siehe `lib/i18n/format.ts`): `brokenLinks` existiert NUR
 * als `brokenLinks_one`/`brokenLinks_other`-Paar.
 */
export const read = {
  breadcrumbAriaLabel: 'Brotkrumen',
  // Kolumnentitel (Erscheinungsbild 2026, Etappe 3): Brotkrumenpfad +
  // Positionsanzeige, s. `components/reading-position.tsx`. `total` zählt die
  // Abschnitte der GANZEN Seite (Serverdaten), nicht die gerade gerenderten.
  runhead: {
    position: 'Abschnitt {current} von {total}',
  },
  status: {
    review: 'In Review',
    draft: 'Entwurf',
    archived: 'Archiviert',
    released: 'Released',
  },
  edit: 'Bearbeiten',
  subbar: {
    updated: 'Aktualisiert',
    space: 'Space',
    // Seitenversionierung Etappe 1 (Task 8): Version + „geändert seit"-
    // Hinweis, wenn seit der letzten Freigabe direkt (an der Freigabe
    // vorbei) committet wurde — nur sichtbar, wenn der Space versioniert
    // ist UND eine Version bekannt ist (s. `components/page-view.tsx`).
    version: 'Version {version}',
    changedSince: 'geändert seit {version}',
    changedSinceHint: 'Diese Seite wurde nach der letzten Freigabe direkt bearbeitet.',
    versionsLink: 'Alle Versionen dieser Seite',
  },
  // Seitenversionierung Etappe 2: Versionsliste und Versionsdiff
  // (`app/wiki/[space]/(shell)/[pageId]/versions/page.tsx`).
  versions: {
    heading: 'Versionen',
    empty: 'Diese Seite hat noch keine freigegebene Version.',
    unversioned: 'Dieser Space führt keine Versionen.',
    current: 'aktuell',
    by: 'von {author}',
    compare: 'Mit heute vergleichen',
    diffHeading: 'Änderungen seit Version {from}',
    diffTo: 'bis Version {to}',
    diffToday: 'bis heute',
    noChanges: 'Seit Version {from} hat sich am Inhalt nichts geändert.',
    gone: 'Der Stand von Version {version} ist nicht mehr verfügbar — die Git-Historie wurde umgeschrieben oder die Seite seither verschoben.',
    unknownVersion: 'Version {version} ist für diese Seite nicht bekannt.',
    loadError: 'Die Versionen konnten nicht geladen werden — der Server ist nicht erreichbar.',
    backToPage: 'Zur Seite',
    railHeading: 'Alle Versionen',
    railAriaLabel: 'Versionen',
  },
  loadError: 'Die Seite konnte nicht geladen werden — der Server ist nicht erreichbar.',
  retry: 'Erneut versuchen',
  notices: {
    draftInReview: 'Es existiert ein Entwurf dieser Seite — er ist im Review.',
    draftPending: 'Es existiert ein Entwurf dieser Seite — noch nicht freigegeben.',
    viewDraft: 'Entwurf ansehen →',
    lockedBySuffix: 'bearbeitet gerade den Entwurf.',
    parseErrorTitle: 'Diese Seite enthält Verarbeitungsfehler',
    frontmatterTitle: 'Hinweise zum Seitenkopf (Frontmatter)',
    frontmatterFallback: 'Der Inhalt wird angezeigt, konnte aber nicht vollständig verarbeitet werden.',
    brokenLinks_one: 'Ein Verweis auf dieser Seite ist nicht auflösbar',
    brokenLinks_other: '{count} Verweise auf dieser Seite sind nicht auflösbar',
  },
  rail: {
    ariaLabel: 'Seiteninformationen',
    toc: 'Inhaltsverzeichnis',
    tags: 'Tags',
    metadata: 'Metadaten',
    status: 'Status',
    space: 'Space',
    updated: 'Aktualisiert',
    relatedPages: 'Verknüpfte Seiten',
  },
  relations: {
    depends_on: 'Hängt ab von',
    supersedes: 'Ersetzt',
    superseded_by: 'Ersetzt durch',
    related: 'Verwandt',
    parent: 'Übergeordnet',
    child: 'Untergeordnet',
    references: 'Verweist auf',
  },
  youtubeTitle: 'YouTube-Video',
  // Vollbild für Bilder und Diagramme bei Fingerbedienung (#67).
  lightbox: {
    ariaLabel: 'Bild im Vollbild',
    close: 'Schließen',
    original: 'Originalgröße',
    fit: 'Einpassen',
    hint: 'Mit zwei Fingern zoomen, zum Verschieben wischen.',
  },
} as const
