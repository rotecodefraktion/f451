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
 * Ebenso `appearance` (`app/einstellungen/erscheinungsbild/page.tsx` +
 * `components/erscheinungsbild-editor.tsx`): eine zweite Einstellungsseite,
 * also eine Schwester von `connections` und keine eigene Namespace-Datei. Die
 * Zeilen-Beschriftungen dieser Seite kommen aus dem Token-Katalog
 * (`lib/erscheinungsbild.ts`, Feld `rolle`) und stehen bewusst NICHT hier —
 * sie sind Katalogtext, nur deutsch, und keine Oberflächensprache.
 */
export const settings = {
  serverUnreachable: 'Der Server ist aktuell nicht erreichbar.',
  retry: 'Erneut versuchen',
  login: {
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
      'Alle Gestaltungswerte dieser Oberfläche, nach Rollen gruppiert. Änderungen wirken sofort und gelten nur in diesem Browser.',
    modeLabel: 'Bearbeiteter Modus',
    modeLight: 'Hell',
    modeDark: 'Dunkel',
    storageHint:
      'Die Änderungen liegen in diesem Browser (localStorage). Andere Personen und andere Geräte sehen sie nicht.',
    resetAll: 'Alles zurücksetzen',
    resetGroup: 'Gruppe zurücksetzen',
    colorPickerLabel: 'Farbwähler für {token}',
    contrast: '{wert}:1 gegen {gegen}',
    contrastLow: 'Unter 4,5:1',
    noRootValue: 'Ohne Grundwert — dieses Token wirkt nur dort, wo es gesetzt wird.',
    notAllowed: 'In einem späteren instanzweiten Theme wäre dieses Token nicht freigegeben: {grund}',
    notAllowedNoReason: 'In einem späteren instanzweiten Theme wäre dieses Token nicht freigegeben.',
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
