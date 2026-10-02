/**
 * Namespace „review" — Review-Seite einer Wiki-Seite (Phase 3): visueller/
 * Markdown-Diff (`components/review/diff-view.tsx`, `lib/review/diff-view-model.ts`),
 * Freigabe-Aktionen (`components/review/review-view.tsx`) sowie der
 * Seitenrahmen inkl. rechter Info-Leiste
 * (`app/wiki/[space]/(shell)/[pageId]/review/page.tsx`). Das Diff-HTML selbst
 * (`diff.blocks[].html`) ist NICHT Teil dieses Namespace — nur das UI-Chrome
 * drumherum.
 */
export const review = {
  loadError: 'Das Review konnte nicht geladen werden — der Server ist nicht erreichbar.',
  retry: 'Erneut versuchen',
  status: {
    review: 'In Review',
  },
  openPr: 'Pull Request öffnen',
  author: 'Autor',
  rail: {
    ariaLabel: 'Änderungen im Pull-Request',
    changesHeading: 'Änderungen',
    prHeading: 'Pull-Request',
    fields: {
      status: 'Status',
      source: 'Quelle',
      target: 'Ziel',
      author: 'Autor',
      number: 'Nummer',
    },
  },
  diff: {
    viewToggleAriaLabel: 'Ansicht umschalten',
    visualTab: 'Visuell',
    markdownTab: 'Markdown',
    legend: {
      added: 'Einfügung',
      changed: 'Geändert',
      removed: 'Entfernt',
    },
    removedSummary: 'Entfernt',
    tag: {
      added: 'Hinzugefügt',
      changed: 'Geändert',
    },
  },
  changesList: {
    newBlock: 'Neuer Inhaltsblock',
    removedBlock: 'Entfernter Inhaltsblock',
    changedBlock: 'Geänderter Inhaltsblock',
  },
  actions: {
    heading: 'Review abschließen',
    commentPlaceholder: 'Kommentar zum Review hinzufügen … (optional bei Freigabe, erforderlich bei Änderungswunsch)',
    commentRequiredHint: 'Für „Änderungen anfragen" ist ein Kommentar erforderlich.',
    merge: 'Freigeben & mergen',
    requestChanges: 'Änderungen anfragen',
    requestChangesDone: 'Änderungen angefordert',
    mergeDisabledTitle: 'Der Entwurf muss aktualisiert werden, bevor er freigegeben werden kann.',
  },
  // Sprunggröße + Änderungsnotiz (Seitenversionierung Etappe 1, Task 9) — nur
  // sichtbar, wenn der Space versioniert ist (`versioning`, s.
  // `components/review/review-view.tsx`). `patch`/`minor`/`major` sind die
  // Beschriftungen NEBEN der berechneten Versionsnummer (`nextVersion`), nicht
  // die Nummer selbst.
  version: {
    legend: 'Version erhöhen',
    patch: 'Korrektur',
    minor: 'Ergänzung',
    major: 'Grundlegend neu',
    // Erstfreigabe (Befund 5, Final-Review): ohne aktuelle Version liefert
    // `nextVersion(undefined, …)` für ALLE drei Sprunggrößen dieselbe Nummer
    // (1.0.0) — drei identische Radiobuttons sahen wie ein Fehler aus. Statt
    // der Auswahl steht hier ein klarer Hinweis, s. `review-view.tsx`.
    firstRelease: 'Dies ist die erste Freigabe dieser Seite — die Version wird {version}.',
    implicitHint: 'Diese Seite wurde noch nie mit Version freigegeben; ihr heutiger Stand zählt als 0.1.0.',
    firstMinor: 'Erste Fassung',
    firstMajor: 'Fertige Fassung',
    archive: 'Als Release festschreiben — eine Kopie dieser Fassung mit Anhängen bleibt dauerhaft lesbar',
    noteLabel: 'Änderungsnotiz',
    notePlaceholder: 'Kurz beschreiben, was sich geändert hat',
  },
  notices: {
    conflictTitle: 'main hat sich geändert.',
    conflictBody: 'Der Entwurf muss aktualisiert werden, bevor er freigegeben werden kann.',
    rebase: 'Entwurf aktualisieren',
    updatedTitle: 'Entwurf aktualisiert',
    updateFailedTitle: 'Entwurf konnte nicht aktualisiert werden',
    preservedContentHint:
      'Dein zuletzt bearbeiteter Entwurfsinhalt ging dabei NICHT verloren — er ist unten gesichert. Kopiere ihn und versuche es erneut, sobald wieder ein Entwurf existiert.',
    close: 'Schließen',
    mergedApproveFailedTitle: 'Gemergt — automatische Freigabe fehlgeschlagen',
    backToReading: 'Zur Leseansicht →',
    mergedSuccess: 'Freigegeben und gemergt — du wirst zur Leseansicht weitergeleitet …',
  },
  errors: {
    conflictOnMerge: 'main hat sich seit Beginn dieses Reviews geändert — bitte den Entwurf zuerst aktualisieren.',
    reviewNoChanges: 'Dieses Review enthält keine Änderungen — es gibt nichts freizugeben. Verwirf den Entwurf, um es zu schließen.',
    mergeFailedRetry: 'Freigeben ist fehlgeschlagen — bitte erneut versuchen.',
    mergeFailedOffline: 'Freigeben ist fehlgeschlagen — der Server ist aktuell nicht erreichbar.',
    requestChangesFailed: 'Änderungen anfordern ist fehlgeschlagen — bitte erneut versuchen.',
    updateFailedRetry: 'Entwurf konnte nicht aktualisiert werden — bitte erneut versuchen.',
  },
  updateDialog: {
    ariaLabel: 'Entwurf aktualisieren',
    heading: 'Entwurf aktualisieren',
    description: 'main hat sich seit Beginn dieses Reviews geändert. Wähle, wie der Entwurf aktualisiert werden soll.',
    takeMain: {
      heading: 'main übernehmen',
      body: 'Verwirft deine Änderungen vollständig und beginnt den Entwurf neu vom aktuellen main-Stand.',
      button: 'main übernehmen',
    },
    keepMine: {
      heading: 'Meine Fassung behalten',
      body: 'Behält deinen Text, setzt ihn aber auf den aktuellen main-Stand auf. Noch nicht gemergte, hochgeladene Bilder gehen dabei verloren.',
      button: 'Meine Fassung behalten',
    },
  },
} as const
