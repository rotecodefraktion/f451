/**
 * Namespace „settings" — der Rahmen um Anmeldung und Konto/Einstellungen
 * (Phase 5 i18n): die Login-Seite (`app/page.tsx`), die
 * Verbindungen-Verwaltung (`app/einstellungen/verbindungen/page.tsx` +
 * `components/disconnect-button.tsx`), das Session-Gate des `/wiki`-Baums
 * (`app/wiki/layout.tsx`) sowie der Space-weite Verweis-Report
 * (`app/wiki/[space]/(shell)/report/page.tsx`). Provider-Namen (Forgejo,
 * GitHub) sind Eigennamen und bleiben. Der „Zugriffs-Tokens"-Bereich
 * (`components/api-tokens-panel.tsx`, MCP-Phase 0) lebt hier als eigener
 * Unter-Namensraum `apiTokens` — eigenes Feature, aber dieselbe Seite
 * (`app/einstellungen/verbindungen/page.tsx`).
 *
 * Likewise `appearance` (`app/einstellungen/erscheinungsbild/page.tsx` +
 * `components/theme-editor/`): a second settings page, a sibling of
 * `connections`, not a namespace file of its own. Group names, role texts and
 * contrast pair descriptions come from the token catalog
 * (`@f451/design-tokens`) and are deliberately NOT here — they are catalog
 * text, German only, not interface language.
 */
export const settings = {
  serverUnreachable: 'Der Server ist aktuell nicht erreichbar.',
  retry: 'Erneut versuchen',
  login: {
    // Claim der Marke unter dem Schriftzug — bleibt in jeder Sprache Englisch.
    claim: 'Documents without handcuffs.',
    heading: 'Anmelden',
    lede: 'Melde dich an, um auf die Dokumentationsplattform zuzugreifen.',
    // Anmeldeweg ohne eingestellten Namen (`F451_OIDC_PROVIDER_NAME` fehlt).
    button: 'Anmelden',
    buttonWith: 'Mit {provider} anmelden',
    foot: 'Interner Zugang · f451 Dokumentationsplattform',
    // Rücksprung der Anmeldung gescheitert (`/auth/callback` leitet mit
    // `?anmeldung=` hierher, statt JSON zu zeigen).
    expired: 'Die Anmeldung wurde unterbrochen oder ist abgelaufen. Bitte melde dich erneut an.',
    failed: 'Die Anmeldung ist fehlgeschlagen. Bitte versuche es erneut.',
  },
  connections: {
    shellSpace: 'Einstellungen',
    navAriaLabel: 'Einstellungen',
    navHeading: 'Einstellungen',
    navSub: 'Konto',
    navItem: 'Verbindungen',
    heading: 'Verbindungen',
    intro:
      'Verknüpfe deinen f451-Account mit Forgejo oder GitHub, um Spaces aus den jeweiligen Repositories einzubinden.',
    connected: 'Verbunden',
    notConnected: 'Nicht verbunden',
    connect: 'Verbinden',
    // Rücksprung der Kontoverknüpfung gescheitert (`?verbindung=`).
    connectExpired: 'Die Verknüpfung wurde unterbrochen oder ist abgelaufen. Bitte verbinde erneut.',
    connectFailed: 'Die Verknüpfung ist fehlgeschlagen. Bitte versuche es erneut.',
    expired: 'Abgelaufen',
    reconnect: 'Neu verbinden',
    expiredHint: '{label} hat die Verknüpfung nicht mehr angenommen. Bis du sie neu herstellst, siehst du keine Spaces aus {label}.',
    disconnect: '{label} trennen',
    disconnecting: 'Wird getrennt …',
    disconnectError: 'Verbindung konnte nicht getrennt werden. Bitte erneut versuchen.',
  },
  appearance: {
    shellSpace: 'Einstellungen',
    navAriaLabel: 'Einstellungen',
    navHeading: 'Einstellungen',
    navSub: 'Konto',
    navItem: 'Erscheinungsbild',
    heading: 'Erscheinungsbild',
    intro:
      'Das Theme der Instanz oder eines einzelnen Space. Es liegt als _meta/theme.yaml im jeweiligen Repository; gespeichert wird mit deinem verknüpften Konto.',
    loadError: 'Das Theme dieses Bereichs konnte nicht geladen werden.',
    noScopes: 'Es gibt keinen Bereich, dessen Theme du ansehen darfst.',
    // Scope selector
    scopeLabel: 'Geltungsbereich',
    scopeInstance: 'Instanz — gilt für alle Spaces',
    scopeSpace: 'Space: {name}',
    scopeReadOnly: '{label} (nur lesen)',
    readOnlyNote: 'Nur lesen: Dein verknüpftes Konto darf das Theme dieses Bereichs nicht ändern. Du siehst, was hier gilt.',
    // Header bar
    summaryErrors_one: '{count} Fehler',
    summaryErrors_other: '{count} Fehler',
    summaryWarnings_one: '{count} Warnung',
    summaryWarnings_other: '{count} Warnungen',
    jumpError: 'Zum ersten Fehler',
    jumpWarning: 'Zur ersten Warnung',
    fileProblem: 'Theme-Datei: {message}',
    // Groups and rows
    groupSetCount_one: '{count} hier gesetzt',
    groupSetCount_other: '{count} hier gesetzt',
    resetGroup: 'Gruppe zurücksetzen',
    modeLight: 'Hell',
    modeDark: 'Dunkel',
    originDefault: 'Vorgabe',
    originInherited: 'geerbt',
    originSet: 'hier gesetzt',
    originPerMode: '{mode}: {origin}',
    resetRow: 'Auf Vorgabe zurücksetzen',
    resetRowLabel: '{token} auf Vorgabe zurücksetzen',
    valueLabel: 'Wert von {token}',
    valueLabelMode: 'Wert von {token} ({mode})',
    colorPickerLabel: 'Farbwähler für {token} ({mode})',
    unitLabel: 'Einheit von {token}',
    formulaLabel: 'Ableitung',
    override: 'übersteuern',
    restoreDerivation: 'Ableitung wiederherstellen',
    lockedReason: 'Gesperrt: {reason}',
    fieldInvalid: 'Ungültiger Wert: {reason}',
    ruleViolation: 'Regel {rule}: {message}',
    // Contrast at the row — the three states of the spec table
    contrastOk: '{ratio}:1 — {what} ✓',
    contrastWarning:
      '{ratio}:1 — {what}: über der eingestellten Schwelle {threshold}:1, unter AA ({aa}:1). Rolle: {role}.',
    contrastWarningLowered:
      '{ratio}:1 — {what}: über der eingestellten Schwelle {threshold}:1 (voreingestellt {default}:1), unter AA ({aa}:1). Rolle: {role}.',
    contrastError: '{ratio}:1 — {what}: {role} braucht hier {threshold}:1.',
    contrastRole: {
      readingText: 'Lesetext',
      shortText: 'kurze Schrift',
      nonText: 'nicht-textliche Zeichen',
      incidental: 'beiläufige Beschriftung',
    },
    // Actions
    save: 'Speichern',
    saving: 'Wird gespeichert …',
    saved: 'Gespeichert.',
    saveBlocked: 'Speichern ist gesperrt, solange Fehler offen sind.',
    removeTheme: 'Theme entfernen',
    removing: 'Wird entfernt …',
    removed: 'Theme entfernt.',
    removeConfirm:
      'Das Theme dieses Bereichs löschen? Die Datei _meta/theme.yaml wird aus dem Repository entfernt, danach gelten wieder die geerbten Werte.',
    serverInvalid: 'Der Server hat das Theme abgelehnt:',
    serverContrast: 'Der Server hat das Theme wegen zu geringen Kontrasts abgelehnt:',
    serverContrastItem: '{what} ({mode}): {ratio}:1, verlangt {threshold}:1',
    serverForbidden: 'Dein verknüpftes Konto darf das Theme dieses Bereichs nicht ändern.',
    serverConflict: 'Die Theme-Datei wurde inzwischen geändert. Lade die Seite neu und versuche es erneut.',
    serverNotFound: 'Es gibt keine Theme-Datei zum Entfernen.',
    serverError: 'Der Vorgang ist fehlgeschlagen. Bitte erneut versuchen.',
  },
  report: {
    heading: 'Verweis-Report',
    intro:
      'Nicht auflösbare Verweise und Beziehungen in diesem Space. Kaputte Verweise sind Daten, keine Fehler — diese Liste ist die Arbeitsvorlage zum Aufräumen.',
    allResolvable: 'Alle Verweise in diesem Space sind auflösbar.',
  },
  apiTokens: {
    heading: 'Persönliche Zugriffs-Tokens',
    introPre:
      'Mit einem persönlichen Zugriffs-Token können externe Werkzeuge (z. B. ein MCP-Server) sich als du gegenüber der API ausweisen. ',
    introStrong: 'Zum Schreiben muss zusätzlich ein Forgejo- oder GitHub-Konto verbunden sein',
    introPost: ' (siehe Verbindungen oben) — ein Token allein reicht nicht, um Änderungen zu committen.',
    revealHintPre: 'Dieses Token wird ',
    revealHintStrong: 'nur jetzt',
    revealHintPost:
      ' angezeigt — kopiere es, bevor du diese Seite verlässt. Danach ist es aus Sicherheitsgründen nicht mehr abrufbar.',
    copied: 'Kopiert ✓',
    copyToClipboard: 'In Zwischenablage kopieren',
    close: 'Schließen',
    labelFieldLabel: 'Label',
    labelPlaceholder: 'z. B. MCP auf meinem Rechner',
    classificationFieldLabel: 'Bis Klassifizierung',
    classificationHint:
      'Seiten mit strengerer Klassifizierung sieht dieses Token nur mit Titel, ohne Inhalt. Nur so weit öffnen, wie der Agent wirklich braucht.',
    classificationPill: 'bis {value}',
    scopeFieldLabel: 'Rechte',
    scopeReadOnly: 'Nur Lesen',
    scopeWriteOption: 'Lesen und Schreiben',
    scopeWritePill: 'Lesen + Schreiben',
    creating: 'Wird erstellt …',
    createButton: 'Token erstellen',
    labelRequired: 'Bitte ein Label vergeben.',
    createError: 'Token konnte nicht erstellt werden. Bitte erneut versuchen.',
    revokeError: 'Token konnte nicht widerrufen werden. Bitte erneut versuchen.',
    revokedStatus: 'Widerrufen',
    revokeButton: 'Widerrufen',
    metaLine: 'Erstellt: {createdAt} · Zuletzt genutzt: {lastUsedAt} · Läuft ab: {expiresAt}',
    emptyList: 'Noch keine Tokens erstellt.',
    neverValue: 'nie',
  },
} as const
