/**
 * Namespace „actions" — Neue-Seite-/Umbenennen-/Verschieben-/Unarchivieren-
 * Dialoge (`components/new-page-button.tsx`, `components/tree-node-actions.tsx`,
 * `components/unarchive-button.tsx`) sowie die verbliebenen Baum-Strings
 * (`components/tree.tsx` Archiv-Badge, `components/tree-dnd.tsx`
 * Umsortierungs-Fehler). `cancel` ist bewusst EIN gemeinsamer Key (identischer
 * „Abbrechen"-Button in allen drei Dialogen) statt je Dialog dupliziert.
 */
export const actions = {
  cancel: 'Abbrechen',
  /** Link zur bereits bestehenden Seite bei einer 409-Kollision — geteilt
   *  zwischen Neue-Seite- (`new-page-button.tsx`) und Verschieben-Dialog
   *  (`tree-node-actions.tsx`), identischer Linktext in beiden. */
  existingPageLink: 'Zur bestehenden Seite →',
  newPage: {
    triggerLabel: 'Neue Seite anlegen',
    dialogAriaLabel: 'Neue Seite anlegen',
    heading: 'Neue Seite anlegen',
    titleLabel: 'Titel',
    parentLegend: 'Übergeordnete Seite',
    parentCurrent: 'Aktuelle Seite',
    parentRoot: 'Space-Wurzel',
    parentFixed: 'Space-Wurzel — keine Seite geöffnet, von der aus abgeleitet werden könnte.',
    templateLegend: 'Vorlage',
    templateEmpty: 'Leer',
    templateGlobalBadge: 'global',
    templatesLoading: 'Vorlagen werden geladen …',
    submit: 'Anlegen',
    genericError: 'Die Seite konnte nicht angelegt werden — bitte erneut versuchen.',
  },
  rename: {
    triggerTitle: 'Umbenennen',
    triggerAriaLabel: '„{title}" umbenennen',
    dialogAriaLabel: 'Seite umbenennen',
    heading: '„{title}" umbenennen',
    fieldLabel: 'Neuer Titel',
    submit: 'Umbenennen',
  },
  move: {
    triggerTitle: 'Verschieben',
    triggerAriaLabel: '„{title}" verschieben',
    dialogAriaLabel: 'Seite verschieben',
    heading: '„{title}" verschieben',
    fieldLabel: 'Neue übergeordnete Seite',
    rootOption: 'Space-Wurzel',
    submit: 'Verschieben',
  },
  moveRename: {
    genericError: 'Verschieben/Umbenennen fehlgeschlagen — bitte erneut versuchen.',
    // Der Server meldet einen Move auf den eigenen Platz als Erfolg mit
    // „0 verschoben". Ohne diesen Satz schlösse sich der Dialog wortlos, und
    // die Seite läge unverändert da — für den Anwender nicht von einem
    // stillen Fehlschlag zu unterscheiden.
    unchanged: 'Die Seite liegt bereits an dieser Stelle — es wurde nichts verändert.',
    // Ein Move mit vielen Unterseiten und Anhängen dauert; die Meldung nimmt
    // dem Warten den Anschein eines Hängers.
    submitting: 'Wird verschoben — bei vielen Unterseiten kann das einen Moment dauern.',
  },
  unarchive: {
    button: 'Aus Archiv holen',
    genericError: 'Aus dem Archiv holen fehlgeschlagen — bitte erneut versuchen.',
  },
  tree: {
    archivedBadge: 'Archiv',
    archivedTitle: '{title} — archiviert (schreibgeschützt)',
  },
  reorder: {
    genericError: 'Umsortieren fehlgeschlagen — bitte erneut versuchen.',
  },
} as const
