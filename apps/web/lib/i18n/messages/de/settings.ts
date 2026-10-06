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
      'Meine Einstellungen gelten nur für dich, in jedem Space, und werden bei deinem Konto gespeichert. Das Theme der Instanz oder eines einzelnen Space liegt als _meta/theme.yaml im jeweiligen Repository; gespeichert wird mit deinem verknüpften Konto.',
    loadError: 'Das Theme dieses Bereichs konnte nicht geladen werden.',
    noScopes: 'Es gibt keinen Bereich, dessen Theme du ansehen darfst.',
    // Scope selector
    scopeLabel: 'Geltungsbereich',
    scopeInstance: 'Instanz — gilt für alle Spaces',
    scopeSpace: 'Space: {name}',
    scopeReadOnly: '{label} (nur lesen)',
    scopeUser: 'Meine Einstellungen',
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
    /** Values of the building-block switches (group „Bausteine"), one key per value. */
    choice: {
      open: 'offen',
      framed: 'gerahmt',
      bar: 'Balken',
      box: 'Kasten',
      ink: 'Tinte',
      accent: 'Akzent',
      'outline-caps': 'Kontur, Versalien',
      filled: 'gefüllt',
      marker: 'Formmarke',
      numeral: 'Ziffer',
      none: 'keine',
      top: 'nur Hauptkapitel',
      all: 'alle Ebenen',
      'numbered-progress': 'nummeriert mit Fortschritt',
      off: 'aus',
      on: 'an',
      rules: 'Haarlinien',
      plain: 'schlicht',
      cards: 'Karten',
      disc: 'Punkt',
      dash: 'Gedankenstrich',
      title: 'Titelzeile',
      toolbar: 'Werkzeugleiste',
      edges: 'Register am Rand',
      topbar: 'in der Kopfleiste',
      sticky: 'so hoch wie der Inhalt',
      own: 'eigener Scrollbereich',
      bottom: 'unten',
    },
    frameGroupNote: 'Wirkt nach dem Speichern: Die Programmvorschau kann den Rahmen nicht tauschen.',
    modeLight: 'Hell',
    modeDark: 'Dunkel',
    originDefault: 'Vorgabe',
    originInherited: 'geerbt',
    originSet: 'hier gesetzt',
    originTemplate: 'Vorlage · {name}',
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
    contrastWarningPersonal:
      '{ratio}:1 — {what}: unter der Schwelle der Instanz ({threshold}:1). In deinen Einstellungen nur ein Hinweis. Rolle: {role}.',
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
    serverForbidden: 'Du darfst das Theme dieses Bereichs nicht ändern — bei Instanz und Space fehlt deinem verknüpften Konto das Schreibrecht, Meine Einstellungen gehen nur mit einer Anmeldung im Browser.',
    serverConflict: 'Die Theme-Datei wurde inzwischen geändert. Lade die Seite neu und versuche es erneut.',
    serverNotFound: 'Es gibt keine Theme-Datei zum Entfernen.',
    serverError: 'Der Vorgang ist fehlgeschlagen. Bitte erneut versuchen.',
    // A space's own theme (scope `space`): removing it falls back to the instance theme
    space: {
      remove: 'Auf Instanz-Theme zurücksetzen',
      removeConfirm:
        'Das eigene Theme dieses Space löschen? Die Datei _meta/theme.yaml wird aus dem Repository des Space entfernt; danach gilt hier wieder das Theme der Instanz.',
      removed: 'Auf das Instanz-Theme zurückgesetzt.',
      ownTheme: 'Dieser Space hat ein eigenes Theme. Seine Werte gelten hier vor denen der Instanz.',
    },
    // "Meine Einstellungen" — the personal theme (scope `user`)
    user: {
      remove: 'Meine Einstellungen zurücksetzen',
      removeConfirm:
        'Meine Einstellungen zurücksetzen? Dein persönliches Theme wird gelöscht, danach gilt wieder das Theme der Instanz und des jeweiligen Space.',
      removed: 'Meine Einstellungen zurückgesetzt.',
      download: 'Herunterladen',
      import: 'Datei einlesen',
      importing: 'Wird eingelesen …',
      imported: 'Datei eingelesen und gespeichert.',
      savedWarnings_one: '{count} Kontrastwert liegt unter den Schwellen der Instanz — erlaubt, nur ein Hinweis.',
      savedWarnings_other: '{count} Kontrastwerte liegen unter den Schwellen der Instanz — erlaubt, nur ein Hinweis.',
      takeover: {
        question:
          'In diesem Browser sind noch Darstellungs-Anpassungen aus einer früheren Version gespeichert. In Meine Einstellungen übernehmen?',
        yes: 'Ja, übernehmen',
        no: 'Nein, verwerfen',
        done: 'Die Anpassungen wurden in Meine Einstellungen übernommen.',
      },
    },
    // Template select and "Als Vorlage speichern" (components/theme-editor/template-select.tsx)
    template: {
      label: 'Vorlage',
      none: 'keine',
      noneCustom: 'Eigene Einstellungen (keine Vorlage)',
      instanceDefault: 'Es gilt die Vorgabe Editorial.',
      underneath: 'Darunter gilt: {what}',
      underneathTemplate: 'Vorlage „{name}“ ({source})',
      underneathCustom: 'eigene Einstellungen ({source})',
      underneathDefault: 'Vorgabe Editorial',
      sourceInstance: 'Instanz',
      sourceSpace: 'Space',
      groupSpace: 'Dieser Space',
      groupInstance: 'Instanz',
      builtin: '{name} (mitgeliefert)',
      unknownOption: '{use} (nicht gefunden)',
      notFound: 'Vorlage „{use}“ nicht gefunden — das Theme gilt ohne Vorlage. Wähle eine andere oder „keine“.',
      loadError: 'Die Vorlagen konnten nicht geladen werden.',
      remove: '×',
      removeLabel: 'Vorlage „{name}“ löschen',
      removeConfirm: 'Die Vorlage „{name}“ löschen? Themes, die sie verwenden, gelten danach ohne Vorlage.',
      removed: 'Vorlage gelöscht.',
      saveAs: 'Als Vorlage speichern …',
      saveAsHint: 'Gespeichert werden die Werte der gewählten Vorlage und dieses Entwurfs — ohne Vorlagen-Auswahl und ohne Marke.',
      adopt: 'Vorlage übernehmen',
      adoptHint:
        'Ersetzt die Werte dieses Entwurfs durch die der gewählten Vorlage; die Vorlage bleibt ausgewählt. Gespeichert wird erst beim Speichern.',
      nameLabel: 'Name',
      slugLabel: 'Kürzel (Dateiname)',
      slugHint: 'a–z, 0–9 und Bindestrich, höchstens 40 Zeichen',
      slugInvalid: 'Das Kürzel darf nur a–z, 0–9 und Bindestriche enthalten, höchstens 40 Zeichen.',
      submit: 'Vorlage speichern',
      saving: 'Wird gespeichert …',
      cancel: 'Abbrechen',
      saved: 'Vorlage „{name}“ gespeichert.',
      overwriteConfirm: 'Die Vorlage „{slug}“ gibt es hier schon. Überschreiben?',
      serverInvalid: 'Der Server hat die Vorlage abgelehnt:',
      serverContrast: 'Der Server hat die Vorlage wegen zu geringen Kontrasts abgelehnt:',
      serverBuiltin: 'Eine mitgelieferte Vorlage kann weder überschrieben noch gelöscht werden — wähle ein anderes Kürzel.',
      serverForbidden: 'Dein verknüpftes Konto darf die Vorlagen dieses Bereichs nicht ändern.',
      serverNotFound: 'Diese Vorlage gibt es nicht mehr.',
    },
    // Brand strip (components/theme-editor/brand-strip.tsx) — instance and space only
    brand: {
      heading: 'Marke',
      intro: 'Name und Logo ersetzen „f451“ in der Kopfzeile und im Fenstertitel. Der Hinweis „Basiert auf f451“ bleibt.',
      nameLabel: 'Name',
      nameHint: 'Wird mit „Speichern“ übernommen. Leer lassen für „f451“.',
      logoHeading: 'Logo',
      logoHint: 'Nur SVG, höchstens 256 KB. Wird sofort gespeichert.',
      noLogo: 'Kein eigenes Logo',
      inheritedLogo: 'Ohne eigenes Logo zeigt dieser Space das Logo der Instanz.',
      previewLabel: 'Logo-Vorschau, {mode}',
      upload: 'Logo hochladen',
      remove: 'Logo entfernen',
      removeConfirm: 'Das Logo entfernen? Die Datei wird aus dem Repository gelöscht.',
      uploaded: 'Logo gespeichert.',
      removed: 'Logo entfernt.',
      faviconHeading: 'Favicon',
      faviconHint: 'Gilt für die ganze Instanz. Nur SVG, höchstens 256 KB.',
      noFavicon: 'Kein eigenes Favicon',
      faviconUpload: 'Favicon hochladen',
      faviconRemove: 'Favicon entfernen',
      faviconRemoveConfirm: 'Das Favicon entfernen? Die Datei wird aus dem Repository gelöscht.',
      faviconUploaded: 'Favicon gespeichert.',
      faviconRemoved: 'Favicon entfernt.',
      working: 'Wird gespeichert …',
      sanitized: 'Die Datei enthielt Teile, die nicht erlaubt sind (z. B. Skripte); gespeichert wurde die bereinigte Fassung.',
      unsavedConfirm: 'Ungespeicherte Änderungen am Theme gehen dabei verloren. Fortfahren?',
      errorNotSvg: 'Die Datei ist kein SVG mit sichtbarem Inhalt.',
      errorTooLarge: 'Die Datei ist größer als 256 KB.',
      errorInvalid: 'Der Server hat die Datei abgelehnt:',
      errorForbidden: 'Dein verknüpftes Konto darf die Marke dieses Bereichs nicht ändern.',
      errorConflict: 'Das Theme wurde zwischenzeitlich geändert. Lade die Seite neu und versuche es noch einmal.',
      errorNotFound: 'Hier gibt es nichts zu entfernen.',
    },
    // Stylesheet strip (components/theme-editor/stylesheet-strip.tsx) — instance and space only
    stylesheet: {
      heading: 'Stylesheet',
      intro: 'Eine eigene CSS-Datei aus dem Repository (_meta/theme.css), ohne Gestaltungsprüfung. Sie wird nach dem Theme geladen.',
      stateNone: 'Kein Stylesheet',
      stateOk: '{size} · Stand {sha}',
      stateInvalid: 'Die Datei verletzt die Regeln und wird nicht geladen ({size} · Stand {sha}):',
      stateTooLarge: 'Die Datei ist größer als 256 KB und wird nicht geladen ({size}).',
      stateUnreadable: 'Die Datei konnte nicht gelesen werden und wird nicht geladen.',
      problemLine: 'Zeile {line}: {message}',
      hint: 'Nur CSS, höchstens 256 KB. Kein @import; url() nur mit data: oder fonts/<name>.woff2. Wird sofort gespeichert.',
      upload: 'Stylesheet hochladen',
      remove: 'Stylesheet entfernen',
      removeConfirm: 'Das Stylesheet entfernen? Die Datei wird aus dem Repository gelöscht.',
      uploaded: 'Stylesheet gespeichert.',
      removed: 'Stylesheet entfernt.',
      working: 'Wird gespeichert …',
      unsavedConfirm: 'Ungespeicherte Änderungen am Theme gehen dabei verloren. Fortfahren?',
      fontsHeading: 'Schriften',
      noFonts: 'Keine Schriftdateien unter _meta/fonts/.',
      fontsHint: 'Schriften kommen nur über Git ins Repository: WOFF2, je Datei höchstens 1 MB, zusammen höchstens 4 MB.',
      fontOk: 'gültig',
      fontInvalid: 'ungültig, wird nicht geladen',
      everywhere: 'Das Stylesheet wirkt auf allen Seiten, auch in der Bausteinvorschau.',
      showWithout: 'Ohne Stylesheet anzeigen',
      skipping: 'Diese Ansicht zeigt die Seite ohne Theme-Stylesheets.',
      showWith: 'Mit Stylesheet anzeigen',
      errorTooLarge: 'Die Datei ist größer als 256 KB.',
      errorNotText: 'Die Datei ist keine CSS-Textdatei.',
      errorInvalid: 'Der Server hat die Datei abgelehnt:',
      errorForbidden: 'Dein verknüpftes Konto darf das Stylesheet dieses Bereichs nicht ändern.',
      errorConflict: 'Das Stylesheet wurde zwischenzeitlich geändert. Lade die Seite neu und versuche es noch einmal.',
      errorNotFound: 'Hier gibt es nichts zu entfernen.',
    },
    // "Prüfschärfe" strip (components/theme-editor/threshold-strip.tsx)
    threshold: {
      heading: 'Prüfschärfe',
      roleBelowAA: '{role} {value}:1 statt {aa}:1',
      roleAtAA: '{role} {value}:1 (AA {aa}:1)',
      belowAACount_one: '{count} Wert unter AA',
      belowAACount_other: '{count} Werte unter AA',
      lowered: 'Mindestens eine Schwelle liegt unter der Voreinstellung.',
      noteLabel: 'Begründung:',
      fieldLabel: '{role} (Voreinstellung {default}:1, AA {aa}:1)',
      noteFieldLabel: 'Begründung (höchstens 500 Zeichen)',
      save: 'Schwellen speichern',
      saving: 'Wird gespeichert …',
      saved: 'Schwellen gespeichert.',
      reset: 'Auf Voreinstellung zurücksetzen',
      resetting: 'Wird zurückgesetzt …',
      resetDone: 'Schwellen auf die Voreinstellung zurückgesetzt.',
      resetConfirm:
        'Die Schwellen auf die Voreinstellung zurücksetzen? Die Datei _meta/contrast.yaml wird aus dem Instanz-Repository entfernt.',
      readOnlyInstance:
        'Die Schwellen gelten für die ganze Instanz und stehen in _meta/contrast.yaml im Instanz-Repository. Ändern kann sie, wer dort Push-Recht hat.',
      readOnlySpace:
        'Die Schwellen gelten für die ganze Instanz; einstellen lassen sie sich nur im Geltungsbereich „Instanz", nicht je Space.',
      errorOff:
        'Die Prüfung lässt sich nicht abschalten. Der kleinste zulässige Wert ist 1,5:1 — darunter sind zwei Farben nicht mehr verlässlich als Schrift und Grund zu unterscheiden.',
      errorRange: '{role}: zulässig sind {min}:1 bis {max}:1.',
      errorPrecision: '{role}: höchstens eine Nachkommastelle.',
      errorNumber: '{role}: bitte eine Zahl eintragen.',
      errorOrder: 'Die Schriftrollen bleiben geordnet: Lesetext ≥ kurze Schrift ≥ beiläufige Beschriftung.',
      errorNote: 'Die Begründung darf höchstens 500 Zeichen lang sein.',
      errorInvalid: 'Der Server hat die Schwellen abgelehnt: {message}',
      errorConnect: 'Verknüpfe zuerst dein Konto, um die Schwellen zu ändern.',
      errorForbidden: 'Dein verknüpftes Konto darf das Instanz-Repository nicht ändern.',
      errorNotConfigured:
        'Für diese Installation ist kein Instanz-Repository eingerichtet (F451_INSTANCE_CONFIG). Es gelten unveränderlich die Voreinstellungen.',
      errorConflict: 'Die Datei _meta/contrast.yaml wurde inzwischen geändert. Lade die Seite neu und versuche es erneut.',
      errorGeneric: 'Der Vorgang ist fehlgeschlagen. Bitte erneut versuchen.',
      infoToggle: 'Warum es Kontrastschwellen gibt',
      reportToggle: 'Bericht „Werte unter AA"',
      reportEmpty: 'Kein Wert liegt unter AA.',
      aaInfo: {
        title: 'Was bedeutet AA?',
        what: 'AA ist die mittlere Stufe der WCAG (Web Content Accessibility Guidelines), der Norm für barrierefreie Webseiten, auf die sich auch Gesetze wie das Barrierefreiheitsstärkungsgesetz beziehen. Für Farben legt sie fest, wie stark sich Schrift und Hintergrund in der Helligkeit unterscheiden müssen — das Kontrastverhältnis. Schwarz auf Weiß ist 21:1, dieselbe Farbe wäre 1:1.',
        levels: 'Text braucht mindestens 4,5:1 (große Schrift 3:1), Bedienelemente, Zeichen und Rahmen mindestens 3:1.',
        howF451:
          'f451 rechnet den Kontrast bei jedem gespeicherten Theme für feste Farbpaare nach — Text auf Papier, Chip-Schrift auf Chip-Fläche, Zeilennummern, Fokusring — getrennt für Hell und Dunkel.',
        twoSteps:
          'Zwei Stufen: Unter der eingestellten Schwelle wird das Speichern verweigert. Darüber, aber unter AA, ist ein Wert eine Warnung: Er blockiert nicht, bleibt aber an der Zeile sichtbar und steht im Bericht „Werte unter AA“.',
        report:
          'Der Bericht ist die vollständige Liste der Werte unter AA, für alle, die es ändern können — und die Grundlage für eine Barrierefreiheitserklärung.',
        guide: 'Mehr dazu im User Guide, Seite Erscheinungsbild → Kontrast und AA.',
      },
      colMode: 'Modus',
      colRatio: 'Gemessen',
      colAA: 'AA-Bezug',
      colThreshold: 'Schwelle',
      colRole: 'Rolle',
      colPair: 'Paar',
      colOrigin: 'Herkunft',
      originInstance: 'Instanz',
      originPair: '{fg}: {fgOrigin} · {bg}: {bgOrigin}',
      copyTable: 'Als Tabelle kopieren',
      copied: 'Kopiert.',
      copyFailed: 'Kopieren ist nicht möglich — die Zwischenablage ist gesperrt.',
    },
    // Text behind the info button (spec "Wortlaut des Info-Knopfes"). Bodies are
    // rendered by threshold-strip.tsx: blank line = paragraph, lines starting with
    // "- " or "1. " = list, **bold**, `code`.
    thresholdInfo: {
      why: {
        heading: 'Warum es Kontrastschwellen gibt',
        body: `Kontrast ist das Verhältnis der Helligkeit zweier Farben. 1:1 heißt: nicht zu unterscheiden. 21:1 ist Schwarz auf Weiß. Zwei Erfolgskriterien der WCAG 2.2 legen fest, was genügt:

- **1.4.3 Kontrast (Minimum)** — Text braucht 4,5:1. Große Schrift (ab 24 px, fett ab 18,7 px) genügt 3:1.
- **1.4.11 Kontrast ohne Text** — Bedienelemente und bedeutungstragende Grafik brauchen 3:1: Fokusring, Zustandszeichen, der Umriss eines Eingabefelds.

Zusammen ergeben sie die Stufe AA, auf die sich Normen und Gesetze beziehen.

f451 rechnet diese Werte bei jedem gespeicherten Farbwert nach, getrennt für Hell und Dunkel, am fertig aufgelösten Satz. Die Schwellen auf dieser Seite bestimmen nur, **ab wann die Prüfung das Speichern verweigert**. Der AA-Bezug selbst lässt sich nicht verstellen: Was ihn verfehlt, wird weiterhin gemeldet und steht im Bericht „Werte unter AA". Eine gesenkte Schwelle macht aus einem Fehler eine Warnung. Sie macht ihn nicht unsichtbar.`,
      },
      who: {
        heading: 'Wen eine Absenkung trifft',
        body: `Nicht eine Norm — Leser:

- **Menschen mit Sehschwäche.** Getrübte Linse, Grauer Star, diabetische Netzhautveränderung, die Wochen nach einer Augenoperation: Die Farbe ist noch da, aber die Kante zwischen Schrift und Papier ist weg.
- **Ältere Nutzer.** Die Kontrastempfindlichkeit des Auges lässt ab etwa fünfzig deutlich nach. Was mit fünfundzwanzig bei 4,5:1 bequem zu lesen war, verlangt dreißig Jahre später merklich mehr. Wer dieses Wiki zehn Jahre lang pflegt, liest es am Ende mit anderen Augen.
- **Bildschirme in hellen Räumen.** Sonne im Besprechungsraum, ein Terminal in der Werkstatt, ein Laptop am Empfang. Streulicht hebt die dunklen Töne an und frisst zuerst die schwachen Kontraste.
- **Beamer.** Ein Projektor in einem nicht abgedunkelten Raum bringt oft nur einen Bruchteil des Bildschirmkontrasts auf die Wand. Eine Zeilennummer mit 2:1 ist dort nicht schwer zu lesen, sondern nicht vorhanden — auch für die, die vorne sitzen.
- **Alle übrigen unter schlechten Bedingungen.** Billiges Panel, Energiesparmodus, schräger Blickwinkel, später Freitagnachmittag.

Sie selbst beurteilen die Farbe gerade unter den günstigsten Umständen: guter Bildschirm, gutes Licht, Ihre Augen — und Sie wissen bereits, was dort steht.`,
      },
      legal: {
        heading: 'Rechtliche Einordnung',
        body: `In Deutschland gilt seit dem 28. Juni 2025 das **Barrierefreiheitsstärkungsgesetz (BFSG)**. Es verpflichtet Anbieter bestimmter Produkte und Dienstleistungen für Verbraucher zur Barrierefreiheit und stützt sich dabei auf die europäische Norm **EN 301 549**, die für Web-Inhalte die WCAG in der Stufe **AA** verlangt. Für **öffentliche Stellen** gilt unabhängig davon die **BITV 2.0**, ebenfalls auf AA-Niveau.

Ob eine dieser Regeln für diese Installation gilt, entscheidet der Einsatzzweck, nicht die Software. Ein internes Firmenwiki hinter der Anmeldung fällt in aller Regel nicht darunter. Eine öffentlich erreichbare Produktdokumentation, eine Wissensbasis als Teil einer Dienstleistung für Verbraucher oder der Betrieb in einer Behörde können sehr wohl darunterfallen. Diese Seite kann Ihnen die Einordnung nicht abnehmen und ist keine Rechtsberatung; im Zweifel ist das eine Frage an Ihre Rechtsabteilung oder an die Barrierefreiheits-Beauftragung Ihres Hauses. Was diese Seite beisteuern kann, ist der Bericht „Werte unter AA": eine vollständige, belegbare Liste dessen, was in dieser Installation unter der Stufe AA liegt.`,
      },
      defaults: {
        heading: 'Warum die Voreinstellungen unter AA liegen',
        body: `Offen gesagt: Das mitgelieferte Erscheinungsbild von f451 hält AA nicht überall ein. Vier Stellen verfehlen es — im Hellmodus, die Zeilennummern auch im Dunkelmodus —, und alle aus demselben Grund: Die farbigen Tönungen mischen mit 10 bis 12 Prozent gegen weißes Papier, und dieselbe Farbe als Schrift darauf kommt nicht über gut 4:1 hinaus:

- Kommentare im Codeblock: 3,63:1
- Zeilennummern im Codeblock: 2,08:1 hell, 2,29:1 dunkel
- die vier Signalfarben als Schrift auf ihrer Tönung: 3,84:1 bis 4,33:1
- die vier Zustandschips: 3,85:1 bis 4,32:1

Die Voreinstellungen — 3,5:1 für kurze Schrift auf einer Fläche, 2,0:1 für Zeilennummern — sind genau so gesetzt, dass diese Werte das Speichern nicht blockieren. Eine Prüfung, die das ausgelieferte Erscheinungsbild ablehnt, wäre nicht streng, sondern unbrauchbar. Praktisch heißt das: **Wenn Sie hier nichts ändern, arbeiten Sie mit einer Prüfung, die an zwei von vier Rollen unter AA liegt.** Für Lesetext (4,5:1) und für nicht-textliche Zeichen (3:1) entspricht die Voreinstellung der Norm; ein Theme, das dort danebengreift, wird weiterhin abgelehnt.`,
      },
      meetAA: {
        heading: 'Wenn Sie AA einhalten wollen',
        body: `Die Schwellen anzuheben genügt nicht — dann lässt sich das mitgelieferte Erscheinungsbild nicht mehr speichern. Der Weg führt über die Farben. Drei Hebel, die ersten beiden auf dieser Seite:

1. **Die Signal- und Zustandsfarben dunkler wählen.** Das wirkt doppelt: gegen das Papier und gegen die eigene Tönung.
2. **Die Tönungen heller mischen.** Je weniger Farbe im Waschton steckt, desto weißer bleibt der Grund und desto besser liest sich die Farbe darauf. Der umgekehrte Griff — die Tönung kräftiger mischen — verschlechtert diesen Wert, weil Schrift und Fläche einander näherkommen.
3. **Kräftige Tönung und trotzdem AA:** Dann trägt die Fläche die normale Textfarbe (13:1 und mehr), und die Signalfarbe bleibt Rand und Zeichen vorbehalten. Das ist keine Theme-Einstellung, sondern eine Änderung am Baustein.

Für den Codeblock genügen zwei Farbwerte, die Sie hier setzen können: Ein Kommentarton von \`#746e61\` statt \`#857e70\` erreicht 4,57:1. Bei den Zeilennummern kostet AA die Staffelung — ein Ton, der 4,5:1 erreicht, ist so kräftig wie der Kommentar daneben; wer den Abstand behalten will, muss die Codefläche heller setzen oder die Zeilennummern bewusst unter AA lassen.

Sind die Farben umgestellt, setzen Sie die Schwellen auf 4,5:1 für Lesetext, kurze Schrift und beiläufige Beschriftung sowie 3,0:1 für nicht-textliche Zeichen. Der Bericht ist dann leer, und jede spätere Änderung, die das bricht, lässt sich nicht mehr speichern.`,
      },
    },
    // Component preview (components/theme-editor/component-preview.tsx). The
    // sample content is interface language: it shows the building blocks, not
    // a real page.
    preview: {
      heading: 'Bausteinvorschau',
      intro: 'Echte Bausteine mit den Werten des Entwurfs. Die Bedienoberfläche selbst behält das gespeicherte Theme.',
      modeGroup: 'Modus der Vorschau',
      stateRest: 'Ruhe',
      stateHover: 'Überfahren',
      stateFocus: 'Fokus',
      stateDisabled: 'Deaktiviert',
      stateActive: 'Aktiv',
      sampleHeading: 'Betrieb und Wartung',
      sampleParagraph:
        'Jede Seite ist eine Markdown-Datei in einem Git-Repository. Wer schreibt, legt einen Entwurf an, eröffnet ein Review und wartet auf die Freigabe — erst dann erscheint die Änderung in der veröffentlichten Fassung.',
      noticeTitle: 'Hinweis',
      noticeBody: 'Diese Seite wird gerade überarbeitet. Die veröffentlichte Fassung bleibt bis zur Freigabe gültig.',
      chipWorking: 'Entwurf',
      chipReview: 'In Review',
      chipReleased: 'Freigegeben',
      chipArchived: 'Archiviert',
      buttonPrimary: 'Freigeben',
      buttonQuiet: 'Abbrechen',
      buttonDanger: 'Löschen',
      tableField: 'Feld',
      tableValue: 'Wert',
      tableRow1Field: 'Verantwortlich',
      tableRow1Value: 'Betrieb',
      tableRow2Field: 'Gültig ab',
      tableRow2Value: '1. Oktober',
      marginalNote: 'Randnotiz: Die Freigabe ist ein Merge im Git-Provider.',
      // Comment line of the sample code block; the commands below it stay code.
      codeComment: '# neu bauen und starten',
      treeRest: 'Einleitung',
      treeHover: 'Installation',
      treeActive: 'Betrieb',
      dialogTitle: 'Seite löschen?',
      dialogBody: 'Die Seite verschwindet erst mit der Freigabe des Reviews.',
      dialogCancel: 'Abbrechen',
      dialogConfirm: 'Löschen',
    },
    // Whole-program preview (components/theme-editor/program-preview.tsx,
    // preview-banner.tsx).
    programPreview: {
      start: 'Im ganzen Programm ausprobieren',
      refresh: 'Aktuellen Entwurf übernehmen',
      end: 'Vorschau beenden',
      hint: 'Nur in diesem Browser und ohne Speichern — sonst sieht es niemand.',
      active: 'Die Vorschau ist aktiv.',
      banner: 'Vorschau aktiv — dieses Erscheinungsbild ist nicht gespeichert und nur in diesem Browser zu sehen.',
      bannerEnd: 'Beenden',
    },
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
