/**
 * Namespace „editor" — der gesamte Editor-Bereich (Phase 2 der UI-Zweisprachigkeit):
 * `components/editor/*` + die reinen `lib/editor/*`-Module, die UI-sichtbaren Text
 * produzieren (`slash-items.ts`, `upload-queue.ts`, `reset-recovery.ts`,
 * `ui-extensions.ts`, `client-api.ts` — nur deren client-seitige Fallback-Fehlertexte).
 *
 * Gliederung: EIN Unterobjekt pro Komponente/Modul (Dateiname → Schlüssel, z. B.
 * `metadataPanel` für `metadata-panel.tsx`), plus ein paar geteilte Top-Level-Keys
 * (`loading`, `retry`, `errors`, `confirm`, `blockReason`), die `EditorRoot`/
 * `EditorSession` in `editor-root.tsx` direkt nutzen.
 *
 * Plural-Konvention (s. `lib/i18n/format.ts`): `_one`/`_other`-Paare. Manche `_one`-
 * Varianten enthalten bewusst KEINE `{count}`-Interpolation (z. B.
 * `wysiwyg.uploadErrors_one`), weil der deutsche Referenztext selbst im Singular
 * keine Zahl zeigt — 1:1 aus dem bisherigen JSX übernommen.
 */
export const editor = {
  loading: 'Entwurf wird geladen …',
  retry: 'Erneut versuchen',

  blockReason: {
    generic: 'Der Wechsel in den WYSIWYG-Modus ist aktuell nicht möglich.',
    single: 'WYSIWYG nicht möglich: {message}',
    multiple: 'WYSIWYG nicht möglich: {count} Stellen sind nicht darstellbar — Details im Befund-Panel.',
  },

  errors: {
    noWriteAccess: 'Du hast kein Schreibrecht für diese Seite.',
    serverUnreachable: 'Der Server ist aktuell nicht erreichbar.',
    loadFailed: 'Der Entwurf konnte nicht geladen werden.',
    discardFailed: 'Der Entwurf konnte nicht verworfen werden — bitte erneut versuchen.',
    deletePageFailed: 'Die Seite konnte nicht gelöscht werden — bitte erneut versuchen.',
    reviewNoDraft: 'Für diese Seite existiert aktuell kein Entwurf — Review kann nicht angefordert werden.',
    reviewNoChanges: 'Dieser Entwurf enthält noch keine Änderungen — bearbeite zuerst die Seite oder verwirf den Entwurf.',
    reviewFailed: 'Review konnte nicht angefordert werden — bitte erneut versuchen.',
    resetFailed: 'Der Entwurf konnte nicht auf den letzten freigegebenen Stand zurückgesetzt werden — bitte erneut versuchen.',
    contentUnreadable: 'Der Editor-Inhalt konnte nicht gelesen werden.',
  },

  confirm: {
    discardResetRecovery: 'Den geretteten Entwurfsinhalt wirklich verwerfen? Er kann danach nicht wiederhergestellt werden.',
    discardDraft: 'Entwurf wirklich verwerfen? Alle ungespeicherten Änderungen gehen unwiderruflich verloren.',
    deletePage: 'Diese Seite wirklich löschen? Der Inhalt wird unwiderruflich aus dem Repository entfernt.',
    resetToLastRelease:
      'Entwurf wirklich auf den zuletzt freigegebenen Stand zurücksetzen? Alle unveröffentlichten Änderungen gehen dabei unwiderruflich verloren.',
  },

  titleField: {
    placeholder: 'Seitentitel',
    ariaLabel: 'Seitentitel',
    archived: 'Archiviert',
    archive: 'Archivieren',
  },

  metadataPanel: {
    noSelection: '— keine Auswahl —',
    removeChip: '"{chip}" entfernen',
    addChipPlaceholder: 'Hinzufügen …',
    invalidPattern: 'Ungültiges Format — erwartet: {pattern}',
    autoHint: 'Wird automatisch ermittelt (noch nicht in dieser Phase — M3b).',
    heading: 'Metadaten',
    missingBadge_one: '{count} Pflichtfeld offen',
    missingBadge_other: '{count} Pflichtfelder offen',
    readOnlyHint: 'Im Rohtext-Modus wird das Frontmatter direkt als Text bearbeitet — hier read-only.',
    requiredHint: 'Pflichtfeld — noch nicht ausgefüllt.',
  },

  statusBar: {
    savedSecondsAgo: 'vor {count}s',
    savedMinutesAgo: 'vor {count} Min',
    breadcrumbAriaLabel: 'Brotkrumen',
    backToReadingTitle: 'Zur Leseansicht zurückkehren',
    draftBadge: 'Entwurf',
    saving: 'Wird gespeichert …',
    offline: 'Änderungen lokal — Server nicht erreichbar',
    error: 'Änderungen nicht gespeichert',
    savedAt: 'Zuletzt gespeichert {relative}',
    notSavedYet: 'Noch nicht gespeichert',
    saveTitle: 'Speichern (⌘S)',
    save: 'Speichern',
    requestReview: 'Review anfordern',
    discard: 'Verwerfen',
    resetToLastRelease: 'Auf letzte Freigabe zurücksetzen',
    backToReading: 'Zur Leseansicht',
    saveAsTemplate: 'Als Vorlage speichern …',
    exportMarkdown: 'Als Markdown exportieren',
    discardDraft: 'Entwurf verwerfen',
    deletePage: 'Seite löschen',
  },

  toolbar: {
    ariaLabel: 'Textformatierung',
    paragraph: 'Absatz',
    heading: 'Überschrift {level}',
    boldTitle: 'Fett (⌘B)',
    italicTitle: 'Kursiv (⌘I)',
    codeTitle: 'Inline-Code (⌘E)',
    linkTitle: 'Link einfügen (⌘K)',
    bulletListTitle: 'Aufzählungsliste',
    orderedListTitle: 'Nummerierte Liste',
    taskListTitle: 'Aufgabenliste',
    tableTitle: 'Tabelle einfügen',
    imageTitle: 'Bild oder Datei einfügen',
    wordCount: '{count} Wörter · {minutes} Min',
    linkPopover: {
      ariaLabel: 'Link einfügen',
      heading: 'Link einfügen',
      urlPlaceholder: 'https://…',
      urlAriaLabel: 'Link-URL',
      selectTextHint: 'Zuerst Text im Dokument markieren.',
      submit: 'Übernehmen',
      remove: 'Entfernen',
      cancel: 'Abbrechen',
    },
  },

  slashMenu: {
    ariaLabel: 'Befehlsmenü',
    heading: 'Block einfügen',
    empty: 'Keine Treffer',
    filterHint: 'Tippe zum Filtern',
    insertHint: 'Einfügen',
  },

  slashItems: {
    heading1: { label: 'Überschrift 1', hint: 'Titelebene' },
    heading2: { label: 'Überschrift 2', hint: 'Abschnittstitel' },
    heading3: { label: 'Überschrift 3', hint: 'Unterabschnitt' },
    bulletList: { label: 'Aufzählung', hint: 'Ungeordnete Liste' },
    orderedList: { label: 'Nummerierte Liste', hint: 'Geordnete Liste' },
    taskList: { label: 'Aufgabenliste', hint: 'Checkliste mit Kästchen' },
    table: { label: 'Tabelle', hint: 'Raster mit Kopfzeile' },
    codeBlock: { label: 'Codeblock', hint: 'Syntax-Hervorhebung' },
    blockquote: { label: 'Zitat', hint: 'Eingerückter Blockzitat' },
    alertNote: { label: 'Hinweis', hint: 'Callout — Info, Warnung' },
    alertTip: { label: 'Tipp', hint: 'Callout — Info, Warnung' },
    alertImportant: { label: 'Wichtig', hint: 'Callout — Info, Warnung' },
    alertWarning: { label: 'Warnung', hint: 'Callout — Info, Warnung' },
    alertCaution: { label: 'Achtung', hint: 'Callout — Info, Warnung' },
    horizontalRule: { label: 'Trennlinie', hint: 'Horizontale Trennung' },
    image: { label: 'Bild/Datei', hint: 'Hochladen und einfügen' },
    drawio: { label: 'draw.io-Diagramm', hint: 'Eingebettetes Flussdiagramm' },
    excalidraw: { label: 'Excalidraw', hint: 'Handgezeichnete Skizze' },
    video: { label: 'Video', hint: 'Einbettung per URL' },
    videoPrompt: 'YouTube-URL (wird als eigene Zeile eingebettet):',
    videoInvalid: 'Das ist keine gültige YouTube-URL (erwartet: youtube.com/watch?v=… oder youtu.be/…).',
  },

  modeSwitch: {
    ariaLabel: 'Editor-Modus',
    wysiwyg: 'WYSIWYG',
    markdown: 'Markdown',
    confirmAriaLabel: 'Formatierung normalisieren?',
    confirmHeading: 'Formatierung wird beim Wechsel normalisiert',
    confirmDescription:
      'Der WYSIWYG-Editor speichert Markdown in einer kanonischen Form — folgende Stellen ändern sich beim Wechsel:',
    cancel: 'Abbrechen',
    confirm: 'Normalisieren und wechseln',
  },

  wysiwyg: {
    loading: 'Editor wird geladen …',
    uploadFailed: 'Der Upload ist fehlgeschlagen — bitte erneut versuchen.',
    conversionErrorTitle: 'Unerwarteter Fehler',
    conversionErrorBody:
      'Der Editor-Inhalt konnte nicht in Markdown umgewandelt werden — bitte lade die Seite neu, bevor du weiterschreibst, sonst gehen Änderungen verloren.',
    uploading: 'Lädt hoch …',
    uploadErrors_one: 'Upload fehlgeschlagen',
    uploadErrors_other: '{count} Uploads fehlgeschlagen',
    skippedFilesTitle: 'Hinweis',
    cellOverflowTitle: 'Nicht möglich',
    cellOverflowBody: 'Eine Tabellenzelle kann nur einen Absatz enthalten.',
    drawioNamePrompt: 'Name des Diagramms:',
    excalidrawNamePrompt: 'Name der Skizze:',
    invalidDiagramName: 'Der Name muss mindestens einen Buchstaben oder eine Ziffer enthalten.',
  },

  lockBanner: {
    messageSuffix: 'bearbeitet gerade den Entwurf.',
    override: 'Trotzdem bearbeiten',
  },

  findingsPanel: {
    openTitle: 'Validierung öffnen',
    ok: 'Keine Befunde',
    count_one: '{count} Befund',
    count_other: '{count} Befunde',
    ariaLabel: 'Validierungsbefunde',
    empty: 'Keine Befunde — das Dokument ist vollständig kanonisch.',
    line: 'Zeile {line}',
  },

  conflictDialog: {
    ariaLabel: 'Speicherkonflikt',
    heading: 'Jemand anderes hat diesen Entwurf zwischenzeitlich gespeichert',
    description: 'Wähle, welche Fassung erhalten bleiben soll — beide Stände lassen sich unten vergleichen.',
    localHeading: 'Deine Fassung',
    serverHeading: 'Stand auf dem Server',
    keepServer: 'Serverstand übernehmen',
    keepMine: 'Meine Fassung behalten',
  },

  offlineRecoveryDialog: {
    ariaLabel: 'Lokal gesicherte Änderungen',
    heading: 'Lokal gesicherte Änderungen gefunden',
    description:
      'Auf diesem Gerät liegt noch ein Entwurfsstand vom {date}, der nicht gespeichert werden konnte (z. B. wegen eines Verbindungsabbruchs). Soll er in den Editor übernommen werden?',
    foreignBranchHint:
      'Hinweis: Dieser Puffer stammt von einem älteren Entwurf dieser Seite, nicht vom aktuell geladenen Stand — prüfe nach dem Übernehmen, ob der Inhalt noch passt.',
    discard: 'Verwerfen',
    apply: 'Übernehmen',
  },

  resetRecoveryDialog: {
    ariaLabel: 'Zurücksetzen fehlgeschlagen',
    heading: 'Zurücksetzen fehlgeschlagen — dein bisheriger Entwurfsinhalt wurde gesichert',
    description:
      'Der Entwurf konnte nicht auf den letzten freigegebenen Stand zurückgesetzt werden. Dein zuletzt bearbeiteter Inhalt ging dabei NICHT verloren — er ist unten gesichert und kann in den Editor übernommen werden.',
    contentHeading: 'Geretteter Entwurfsinhalt',
    discard: 'Verwerfen',
    apply: 'Inhalt in den Editor übernehmen',
  },

  saveTemplateDialog: {
    heading: 'Als Vorlage speichern',
    savedPrefix: 'Vorlage gespeichert unter',
    nameLabel: 'Name',
    descriptionLabel: 'Beschreibung',
    genericError: 'Die Vorlage konnte nicht gespeichert werden — bitte erneut versuchen.',
    close: 'Schließen',
    cancel: 'Abbrechen',
    save: 'Speichern',
  },

  drawioDialog: {
    iframeTitle: 'draw.io-Diagramm bearbeiten',
    close: 'Schließen',
    loadFailed: 'Diagramm konnte nicht geladen werden.',
    saveFailed: 'Speichern fehlgeschlagen — bitte erneut versuchen.',
    nameExists: 'Eine Datei mit diesem Namen existiert bereits.',
    loading: 'Diagramm wird geladen …',
  },

  excalidrawDialog: {
    loadFailed: 'Die Skizze konnte nicht geladen werden.',
    nameExists: 'Eine Datei mit diesem Namen existiert bereits.',
    saveFailed: 'Speichern fehlgeschlagen — bitte erneut versuchen.',
    loading: 'Skizze wird geladen …',
    cancel: 'Abbrechen',
    saving: 'Wird gespeichert …',
    saveAndClose: 'Speichern und schließen',
  },

  wikiLinkPopup: {
    headingPrefix: 'Seite verlinken ·',
    searching: 'Suche läuft …',
    empty: 'Keine Treffer',
    draftBadge: 'Entwurf',
    ariaLabel: 'Seiten-Autocomplete',
    navigate: 'Navigieren',
    insert: 'Einfügen',
    cancel: 'Abbrechen',
  },

  diagramNode: {
    editButton: 'Diagramm bearbeiten',
  },

  uploadQueue: {
    skipped_one: '{count} Datei übersprungen — nicht unterstützter Dateityp.',
    skipped_other: '{count} Dateien übersprungen — nicht unterstützter Dateityp.',
  },

  clientApi: {
    uploadFailedDefault: 'Upload fehlgeschlagen.',
    invalidTemplateName: 'Ungültiger Name.',
    noTemplatePermission: 'Kein Recht, Templates in diesem Space anzulegen.',
    templateNameExists: 'Unter diesem Namen existiert bereits ein Template.',
  },
} as const
