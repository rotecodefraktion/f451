// Reine Klassifizierung eines im Autosave-Catch gefangenen Fehlers in den
// `SaveOutcome`, den die Autosave-State-Machine bekommt (Phase 4b Task 2,
// Fix-Runde 1). Bewusst als node-testbares Modul ohne React/DOM ausgelagert —
// dieselbe Trennung wie `autosave.ts`/`offline-buffer.ts`: die Entscheidung
// „wann darf der selbstheilende `offline`-Zustand signalisiert werden" ist
// integritätskritisch (ein `offline`-Statusband verspricht „Änderungen lokal
// gesichert") und wird deshalb hier isoliert getestet, statt nur im
// React-Aufrufer per Code-Review abgesichert zu sein.

import type { SaveOutcome } from './autosave.js'
import { ClientApiError, SessionExpiredError } from './client-api.js'

/**
 * Entscheidet, welchen {@link SaveOutcome} der Aufrufer nach einem
 * fehlgeschlagenen `saveDraft` an die State-Machine meldet.
 *
 * @param err       der im `catch` gefangene Fehler.
 * @param buffered  Ergebnis von `writeOfflineDraft` für diesen Fehlversuch —
 *                  `true` nur, wenn der aktuelle Inhalt WIRKLICH lokal
 *                  gesichert wurde. `false` bei Quota/Safari-Private-Mode
 *                  ODER wenn der Editor-Inhalt gar nicht lesbar war
 *                  (`readCurrentContent().ok === false`, harter 2c-Vertrag:
 *                  ok:false puffert nie).
 *
 * Regeln:
 * - {@link SessionExpiredError} (401) → `'error'`: die Login-Umleitung läuft
 *   in `client-api.ts` bereits, der Autosave-Zustand ist bis zur Navigation
 *   irrelevant. Der `error`-Zustand signalisiert wenigstens keine falsche
 *   Sicherheit, falls die Pufferung ihrerseits scheiterte.
 * - {@link ClientApiError} mit Netzwerkfehler (`status === 0`) oder Serverfehler
 *   (`status >= 500`) UND `buffered === true` → `'offline-error'`: nur DANN darf
 *   der selbstheilende `offline`-Zustand mit „Änderungen lokal" erreicht werden,
 *   weil nur dann tatsächlich etwas gesichert ist, das ein Reload überlebt.
 * - jeder andere Fall (nicht-transienter Fehler wie 403; ODER Netz/5xx, aber
 *   `buffered === false`) → `'error'`: ehrlicher, sichtbarer Fehlzustand statt
 *   eines Versprechens, das nicht haltbar ist.
 */
export function classifySaveFailure(err: unknown, buffered: boolean): SaveOutcome {
  if (err instanceof SessionExpiredError) return 'error'
  if (buffered && err instanceof ClientApiError && (err.status === 0 || err.status >= 500)) {
    return 'offline-error'
  }
  return 'error'
}
