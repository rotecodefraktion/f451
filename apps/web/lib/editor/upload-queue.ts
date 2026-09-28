import type { T } from '../i18n/types.js'

// --- Media-Upload-Queue: reine Zähl-/Klassifikations-/Fehlersammellogik (Phase 2c
// Task 5, Fix-Runde 1 — Review-Finding 1+2; erweitert um Nicht-Bild-Anhänge) --------
//
// Finding 1 (ui-extensions.ts#mediaPasteAndDropExtension): ein Drop/Paste-Event mit
// mehreren Dateien darf nicht mehr nur die erste hochladbare Datei verarbeiten und
// den Rest stillschweigend verwerfen (Spec §9). `splitUploadFiles` trennt ALLE
// hochladbaren Dateien — Bilder UND die serverseitig erlaubten Dokumenttypen (PDF/
// Office/ZIP/Text, s. `DOCUMENT_EXTENSIONS`, Whitelist muss zu
// `apps/api/src/drafts/upload.ts#DOCUMENT_EXTENSION_WHITELIST` passen) — in
// Event-Reihenfolge (für sequenziellen Upload + Insert an der richtigen Stelle) von
// den übersprungenen, wirklich NICHT unterstützten Dateien (nur noch gezählt, für
// eine Sammel-Notice statt stillen Verlusts, s. `skippedFilesNotice`). Ob eine
// hochgeladene Datei danach als Bild (`setImage`) oder als Datei-Link eingefügt wird,
// entscheidet NICHT diese Client-Vorklassifizierung, sondern das `kind`-Feld der
// Server-Antwort (s. wysiwyg-editor.tsx) — die serverseitige Magic-Bytes-Prüfung ist
// die verbindliche Wahrheit.
//
// Finding 2 (wysiwyg-editor.tsx): zwei gleichzeitige Upload-Vorgänge (z. B.
// Datei-Dialog + Drop) dürfen sich nicht gegenseitig überschreiben — weder der
// Ladehinweis (bisher ein Einzel-Boolean „uploading") noch die Fehlermeldung
// (bisher ein Einzel-String „uploadError"). `uploadQueueReducer` ersetzt beide
// durch einen Zähler (aktive Uploads > 0 ⇒ „lädt") und eine Fehlerliste
// (append-only während ein Batch läuft). Reine Zustandsmaschine, kein React, keine
// Seiteneffekte — wysiwyg-editor.tsx ruft `uploadMedia` selbst auf und meldet
// Start/Erfolg/Fehler hierüber zurück (dünner Konsument, s. Task-Brief).

/** Client-seitige Vorklassifizierung erlaubter Nicht-Bild-Anhänge — MUSS zur
 *  serverseitigen Whitelist passen (`apps/api/src/drafts/upload.ts#DOCUMENT_EXTENSION_WHITELIST`).
 *  Nur ein Vorfilter (verhindert einen unnötigen Upload-Versuch offensichtlich nicht
 *  unterstützter Dateien) — die verbindliche Prüfung (Magic-Bytes) läuft serverseitig. */
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'zip', 'txt', 'csv', 'md'])

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

/** Bild (per MIME-Type) ODER ein Dateiname mit einer der erlaubten Dokument-Endungen. */
export function isUploadableFile(file: File): boolean {
  return file.type.startsWith('image/') || DOCUMENT_EXTENSIONS.has(extensionOf(file.name))
}

export interface SplitFilesResult {
  /** Hochladbare Dateien (Bilder + erlaubte Dokumenttypen) in Event-Reihenfolge
   *  (unverändert — die Reihenfolge bestimmt die Einfüge-Reihenfolge im Dokument). */
  uploadable: File[]
  /** Anzahl NICHT unterstützter Dateien im selben Event — nur gezählt, s. `skippedFilesNotice`. */
  skippedCount: number
}

/** Trennt die Dateien eines Drop-/Paste-Events in hochladbare (Bilder + Dokumente,
 *  werden hochgeladen) und übersprungene, wirklich nicht unterstützte Dateien (werden
 *  nur gezählt, nie still verworfen — Spec §9, s. `skippedFilesNotice`). */
export function splitUploadFiles(files: File[]): SplitFilesResult {
  const uploadable: File[] = []
  let skippedCount = 0
  for (const file of files) {
    if (isUploadableFile(file)) uploadable.push(file)
    else skippedCount += 1
  }
  return { uploadable, skippedCount }
}

/** Text für die Sammel-Notice wirklich übersprungener Dateien (Finding 1: „nie
 *  stilles Verwerfen" statt gar keiner Meldung) — NUR für Dateitypen, die weder als
 *  Bild noch als Dokument-Anhang unterstützt werden. `t` kommt von der aufrufenden
 *  React-Komponente (`wysiwyg-editor.tsx`s `useT()`) — dieses Modul ist (wie jedes
 *  `lib/**`-Modul) hook-frei, s. `lib/i18n/types.ts#T`. */
export function skippedFilesNotice(count: number, t: T): string {
  return t('editor.uploadQueue.skipped', { count })
}

export interface UploadQueueState {
  /** Anzahl gerade laufender Uploads. `active > 0` ⇒ Ladehinweis zeigen (ersetzt
   *  den alten Einzel-Boolean `uploading`, der bei zwei gleichzeitigen Uploads den
   *  falschen Zustand zeigen konnte, s. Finding 2). */
  active: number
  /** Fehlermeldungen des laufenden Batches — append-only während `active > 0`,
   *  damit ein zweiter, gleichzeitig laufender Upload die Fehlermeldung des
   *  ersten nicht überschreibt (Finding 2). */
  errors: string[]
}

export const initialUploadQueueState: UploadQueueState = { active: 0, errors: [] }

export type UploadQueueEvent =
  /** `count` neue Uploads starten (ein Drop/Paste-Event kann mehrere Dateien auf
   *  einmal anstoßen, s. `splitUploadFiles`). Beginnt eine neue Fehlerliste NUR,
   *  wenn zu diesem Zeitpunkt kein anderer Upload mehr aktiv ist (`active === 0`)
   *  — läuft noch einer, bleiben dessen bereits gesammelte Fehler stehen, statt
   *  von einem zweiten, gleichzeitig gestarteten Batch gelöscht zu werden. */
  | { type: 'start'; count: number }
  /** Ein Upload ist erfolgreich abgeschlossen. */
  | { type: 'success' }
  /** Ein Upload ist fehlgeschlagen — `message` wird der Fehlerliste angehängt
   *  (nicht ersetzt, s. Feld-Kommentar `errors`). */
  | { type: 'error'; message: string }

/** Reine Zustandsmaschine für die Upload-Queue — s. Modulkopf. */
export function uploadQueueReducer(state: UploadQueueState, event: UploadQueueEvent): UploadQueueState {
  switch (event.type) {
    case 'start':
      return { active: state.active + event.count, errors: state.active === 0 ? [] : state.errors }
    case 'success':
      return { active: Math.max(0, state.active - 1), errors: state.errors }
    case 'error':
      return { active: Math.max(0, state.active - 1), errors: [...state.errors, event.message] }
    default:
      return state
  }
}
