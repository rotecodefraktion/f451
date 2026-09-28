/**
 * Namespace „schema" — Metadaten-Schema-Editor (Metadaten-Feature M4):
 * die Seite (`app/wiki/[space]/(shell)/schema/page.tsx`) und der Editor
 * (`components/editor/metadata-schema-editor.tsx`), der `_meta/schema.yaml`
 * eines Space pflegt. Übersetzt wird NUR die UI-Chrome (Feldbeschriftungen,
 * Typ-/Quellen-Auswahllabels, Buttons, Statusmeldungen). Die vom Nutzer
 * eingegebenen Feld-Schlüssel/-Anzeigenamen/-Optionen sind INHALT und bleiben.
 */
export const schema = {
  pageTitle: 'Metadaten-Schema',
  pageIntro:
    'Definiert die strukturierten Zusatzfelder (z. B. Process ID, Status, Freigegeben von), die Seiten in diesem Space im Erfass-Formular anzeigen. Änderungen werden direkt gespeichert und gelten sofort für alle Seiten.',
  typeLabels: {
    text: 'Text',
    pattern: 'Muster (Regex)',
    enum: 'Auswahl (fest, einzeln)',
    date: 'Datum',
    multi: 'Mehrfachauswahl / Tags',
    user: 'Person',
    auto: 'Automatisch (aus Git)',
  },
  sourceLabels: {
    last_author: 'Letzter Autor',
    last_updated: 'Letzte Änderung',
  },
  fieldNumber: 'Feld {n}',
  moveUp: 'Nach oben verschieben',
  moveDown: 'Nach unten verschieben',
  remove: 'Entfernen',
  key: 'Schlüssel',
  displayName: 'Anzeigename',
  type: 'Typ',
  required: 'Pflichtfeld',
  pattern: 'Regex-Muster',
  patternHint: 'Hinweistext bei ungültigem Format',
  optionsEnum: 'Optionen (eine pro Zeile)',
  optionsMulti: 'Optionen (eine pro Zeile — leer = freie Tag-Eingabe)',
  fillOnReleaseUser: 'Beim Freigeben mit dem freigebenden Nutzer vorbelegen (falls noch leer)',
  fillOnReleaseDate: 'Beim Freigeben mit dem Freigabedatum vorbelegen (falls noch leer)',
  source: 'Quelle',
  sourcePlaceholder: '— bitte wählen —',
  empty:
    'Dieser Space hat noch kein Metadaten-Schema. Fügen Sie ein Feld hinzu, um strukturierte Zusatzangaben (z. B. Process ID, Status, Freigegeben von) für Seiten in diesem Space zu definieren.',
  addField: '+ Feld hinzufügen',
  saving: 'Speichert …',
  save: 'Speichern',
  saved: 'Schema gespeichert.',
  invalid: 'Das Metadaten-Schema ist ungültig — s. Details unten.',
  saveFailed: 'Das Schema konnte nicht gespeichert werden — bitte erneut versuchen.',
  notSavableYet: 'Noch nicht speicherbar:',
} as const
