/**
 * Namespace „templates" — Vorlagen-Pflege (Werkzeuge-Bereich „Vorlagen"):
 * die Seite (`app/wiki/[space]/(shell)/templates/page.tsx`) und der Manager
 * (`components/editor/templates-manager.tsx`), der `_templates/*.md` eines
 * Space pflegt (Umbenennen/Inhalt bearbeiten/Löschen). Vorlagen-Namen,
 * -Beschreibungen und -Inhalte sind INHALT und bleiben unübersetzt.
 */
export const templates = {
  pageTitle: 'Vorlagen',
  intro1: 'Vorlagen für neue Seiten in diesem Space (',
  intro2:
    '). Space-Vorlagen können hier umbenannt, inhaltlich bearbeitet und gelöscht werden — Änderungen landen direkt auf ',
  intro3: '. Globale Vorlagen sind schreibgeschützt und nur zur Übersicht aufgeführt.',
  empty: 'In diesem Space sind noch keine Vorlagen hinterlegt.',
  global: 'global',
  readOnly: 'schreibgeschützt',
  rename: 'Umbenennen',
  editContent: 'Inhalt bearbeiten',
  delete: 'Löschen',
  deleting: 'Löscht …',
  deleteConfirm: 'Vorlage "{name}" wirklich löschen? Das kann nicht rückgängig gemacht werden.',
  name: 'Name',
  description: 'Beschreibung',
  cancel: 'Abbrechen',
  save: 'Speichern',
  saving: 'Speichert …',
  contentLabel: 'Inhalt (Markdown)',
  contentLoading: 'Inhalt wird geladen …',
  close: 'Schließen',
  errors: {
    renameFailed: 'Die Vorlage konnte nicht umbenannt werden',
    contentLoadFailed: 'Der Inhalt konnte nicht geladen werden',
    contentSaveFailed: 'Der Inhalt konnte nicht gespeichert werden',
    deleteFailed: 'Die Vorlage konnte nicht gelöscht werden',
    retry: '{action} — bitte erneut versuchen.',
    reloadFailed: 'Die Vorlagen-Liste konnte nicht neu geladen werden — bitte die Seite neu laden.',
  },
} as const
