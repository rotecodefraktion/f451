import type { OfflineDraft } from './offline-buffer.js'

/**
 * Reine Entscheidungslogik für die Mount-Recovery (Phase 4b Task 3, Spec §9):
 * ein von Task 2 gepufferter Entwurf (`writeOfflineDraft` im Autosave-Catch)
 * wird NIE still eingespielt — der Nutzer könnte ihn bewusst verworfen haben
 * (z. B. „Serverstand übernehmen" im Konflikt-Dialog, das Task 2 selbst per
 * `clearOfflineDraft` nach `handleKeepServerVersion` räumt; existiert dann
 * kein Puffer mehr, liest diese Funktion auch keinen — sie liest nur, was
 * TATSÄCHLICH noch da ist, sie belebt nichts wieder). Jede andere Situation
 * mit abweichendem Inhalt zeigt stattdessen einen Dialog, der Aufrufer
 * (`editor-root.tsx#load`) entscheidet dann über `onApply`/`onDiscard`.
 *
 * Als eigenes, pures Modul ausgelagert (Muster `save-failure.ts`/
 * `reset-recovery.ts`/`mode-switch-core.ts`) — node-testbar ohne DOM, weil
 * diese Entscheidung integritätskritisch ist (falsch entschieden verliert sie
 * entweder lokal gepufferte Änderungen ODER überschreibt unbemerkt den
 * Server-Stand).
 */
export type OfflineRecoveryDecision = 'none' | 'offer'

/**
 * @param buffered  Ergebnis von `readOfflineDraft(pageId)` beim Mount —
 *                   `null`, wenn kein Puffer existiert (nichts zu tun) oder
 *                   nur ein korrupter Eintrag da war (den räumt `readOfflineDraft`
 *                   bereits selbst, s. `offline-buffer.ts`).
 * @param draft     Der frisch geladene Server-Draft (`branch`/`content` aus
 *                   `createDraft`, `content` ist das VOLLE Dokument inkl.
 *                   Frontmatter — derselbe Vertrag wie `buffered.content`).
 *
 * Regeln (Reihenfolge = Priorität):
 * 1. kein Puffer → `'none'`.
 * 2. `buffered.content === draft.content` → `'none'` — identischer Inhalt
 *    heißt: nichts zu gewinnen, der Puffer ist überflüssig geworden (z. B.
 *    weil derselbe Stand inzwischen regulär gespeichert wurde). Der Aufrufer
 *    räumt ihn in diesem Fall STILL per `clearOfflineDraft` (kein Dialog für
 *    ein Ergebnis, das dem Nutzer nichts zurückgeben würde).
 * 3. gleicher `branch`, abweichender Inhalt → `'offer'` — der Normalfall
 *    (Autosave scheiterte, derselbe Draft-Branch existiert unverändert).
 * 4. fremder `branch` (der Puffer stammt von einem inzwischen released/
 *    verworfenen Entwurf) → ebenfalls `'offer'`, konservativ: ein möglicher
 *    Datenverlust wiegt schwerer als ein unnötig gezeigter Dialog. Der
 *    Aufrufer/Dialog zeigt in diesem Fall zusätzlich den Hinweis, dass der
 *    Puffer von einem älteren Entwurf stammt (s. `OfflineRecoveryDialog`).
 */
export function evaluateOfflineRecovery(
  buffered: OfflineDraft | null,
  draft: { branch: string; content: string },
): OfflineRecoveryDecision {
  if (!buffered) return 'none'
  if (buffered.content === draft.content) return 'none'
  // Ab hier weicht der Inhalt ab — ob `buffered.branch === draft.branch` gilt,
  // ändert NICHT das Ergebnis (in beiden Fällen `'offer'`, Regeln 3+4 oben),
  // sondern nur, ob der Dialog den Fremd-Branch-Hinweis zusätzlich zeigt.
  return 'offer'
}
