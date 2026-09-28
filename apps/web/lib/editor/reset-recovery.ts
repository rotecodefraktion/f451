import type { UpdateDraftResult } from './client-api'
import type { T } from '../i18n/types'

/**
 * Reine Entscheidungslogik für den Fehlerpfad von „Auf letzte Freigabe
 * zurücksetzen" (Phase 2d Task 6, Fix-Runde 1 — Finding 1: stiller
 * Datenverlust). `updateDraft({strategy:'take-main'})` verwirft den
 * Draft-Branch VOR der Neuanlage (`apps/api/README.md` „Content-Verlust-
 * Fenster") — schlägt einer der Folgeschritte fehl, trägt die `502`-Antwort
 * `preservedContent`: den Inhalt, der unmittelbar vor dem Verwerfen auf dem
 * (jetzt gelöschten) Draft-Branch stand. NUR dieser Fall darf still bleiben
 * — er ist keiner: der Aufrufer muss eine Wiederherstellungs-Möglichkeit
 * zeigen statt einer reinen Fehlermeldung. Ein Fehler VOR dem Verwerfen (kein
 * `preservedContent`) hat dagegen nichts zu retten — der alte Draft-Branch
 * existiert unverändert weiter, die bisherige Fehlermeldung genügt.
 *
 * Als eigenes, pures Modul ausgelagert (statt inline in `editor-root.tsx`),
 * weil dies die einzige Verzweigung dieses Fixes ist, die ohne React/DOM
 * node-testbar ist — die eigentliche Wiederherstellung (Editor-Inhalt setzen,
 * dirty markieren) hängt an React-Refs/State der `EditorSession` und bleibt
 * dort (Muster `handleKeepServerVersion`).
 */
export type ResetFailureOutcome =
  | { kind: 'recoverable'; preservedContent: string }
  | { kind: 'lost'; message: string }

/** Nimmt das `ok:false`-Ergebnis von `updateDraft` entgegen und entscheidet,
 *  ob der Aufrufer die Wiederherstellungs-UI (`preservedContent` vorhanden)
 *  oder nur die bisherige Fehlermeldung zeigen muss. `t` kommt von der
 *  aufrufenden React-Komponente (`editor-root.tsx`, `useT()`/`getT()`) — dieses
 *  Modul selbst ist kein Hook-fähiger Kontext (Phase-2-i18n-Konvention, s.
 *  `lib/i18n/types.ts#T`). */
export function describeResetFailure(result: Extract<UpdateDraftResult, { ok: false }>, t: T): ResetFailureOutcome {
  if (result.preservedContent !== undefined) {
    return { kind: 'recoverable', preservedContent: result.preservedContent }
  }
  return { kind: 'lost', message: t('editor.errors.resetFailed') }
}
