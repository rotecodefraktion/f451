/**
 * Namespace „shell" — Topbar + deren Popover (Theme-/Sprach-Umschalter,
 * Space-Switcher, Konto-Menü, Such-Trigger). Siehe `lib/i18n/messages/index.ts`
 * für die Namespace-Konvention.
 */
export const shell = {
  meta: {
    title: 'f451 — Dokumentationsplattform',
    /** With a brand name from the theme (`brand.name`) in place of "f451". */
    brandTitle: '{name} — Dokumentationsplattform',
  },
  topbar: {
    homeAriaLabel: 'Zur Startseite',
  },
  themeToggle: {
    title: 'Hell/Dunkel umschalten',
    ariaLabel: 'Theme umschalten',
  },
  /** Die beiden Daumenregister des Fünf-Spalten-Rasters (`app/pane-edges.tsx`).
   *  Das Zeichen im Schalter trägt den Zustand, das Wort benennt die Leiste,
   *  der Titel nennt zusätzlich das Tastenkürzel. */
  panes: {
    nav: {
      label: 'Seitenbaum',
      title: 'Seitenbaum ein- und ausklappen (Taste [ )',
    },
    rail: {
      label: 'Info-Leiste',
      title: 'Info-Leiste ein- und ausklappen (Taste ] )',
    },
    /** Magnifier on the left edge without a top bar, while the tree is closed. */
    search: {
      label: 'Suchen',
      title: 'Suchen (⌘K)',
    },
  },
  // Telefon-Leiste (#66, Variante B): nur unter 700 px bei Fingerbedienung.
  // Attribution required by the f451 License (see LICENSE.md, "Attribution").
  attribution: {
    before: 'Basiert auf ',
    between: ' von ',
    imprint: 'Impressum',
    privacy: 'Datenschutz',
  },
  phoneBar: {
    ariaLabel: 'Bereiche',
    nav: 'Seiten',
    toc: 'Gliederung',
    info: 'Info',
    next: 'Weiter',
    nextTitle: 'Zur nächsten Seite im Seitenbaum',
    close: 'Schließen',
  },
  langSwitcher: {
    title: 'Sprache wechseln',
    ariaLabel: 'Sprache wechseln',
    menuAriaLabel: 'Sprache wählen',
    locales: {
      de: 'Deutsch',
      en: 'Englisch',
    },
  },
  spaceSwitcher: {
    menuAriaLabel: 'Space wechseln',
  },
  account: {
    menuAriaLabel: 'Konto-Menü',
    settingsLabel: 'Einstellungen',
    settingsSubtitle: 'Verbindungen verwalten',
    logout: 'Abmelden',
    loggingOut: 'Wird abgemeldet …',
  },
  search: {
    placeholder: 'Seiten, Spaces, Personen suchen …',
    short: 'Suchen',
  },
} as const
