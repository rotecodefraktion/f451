/**
 * Reine Autosave-State-Machine (Phase 2c Task 4) — kein React, kein `fetch`,
 * vollständig node-testbar (Zeit kommt IMMER als `now`-Parameter herein, nie
 * `Date.now()`/`setTimeout` direkt aus dem Modul heraus). Der React-Hook in
 * `editor-root.tsx` bleibt dünn: er liest `dueAt()`, setzt einen Timer, und
 * treibt beim Ablauf den eigentlichen `saveDraft`-Aufruf — diese Datei
 * entscheidet nur noch, OB und WANN gespeichert werden darf.
 *
 * Übergänge (Brief-Diagramm): `idle → dirty(t) → saving → idle | conflict`.
 * `error` ist ein eigener, sichtbarer Endzustand für erschöpften Backoff
 * (siehe {@link SaveOutcome}) — aus ihm heraus bleibt sowohl eine neue
 * Änderung (`onChange`, setzt den Zähler zurück) als auch ein manueller
 * Retry (`flushNow`) möglich.
 *
 * `conflict` ist bewusst eingefroren: `dueAt()` liefert dort IMMER `null`
 * (kein Timer-Pfad kann je automatisch auslösen), `onChange` ist dort ein
 * No-Op, und `flushNow` liefert dort IMMER `false` (Review-Fund 2, Phase 2c
 * Task 4: ein globaler ⌘S-Handler bubbelt sonst durch den fokussierten
 * Konflikt-Dialog hindurch und würde einen zweiten Save mit frischem
 * Editor-Inhalt, aber altem `baseSha` auslösen — DEFENSE IN DEPTH zusätzlich
 * zum früh returnenden Handler in `editor-root.tsx`, nicht redundant: die
 * State-Machine bleibt auch dann korrekt, wenn ein künftiger Aufrufer diese
 * Prüfung vergisst). Die einzige Fortsetzung aus `conflict` ist ein
 * expliziter {@link Autosave.resolveConflict}-Aufruf aus dem Konflikt-Dialog
 * heraus (Spec Abschnitt 9: kein stilles Überschreiben).
 *
 * `offline` (Phase 4b Task 2) ist das selbstheilende Gegenstück zu `error`:
 * beide werden nach `maxAttempts` erschöpftem Backoff erreicht, aber nur wenn
 * der Aufrufer den letzten Fehlversuch als `'offline-error'` klassifiziert
 * (Netzwerkfehler/5xx — die Klassifizierung selbst passiert NICHT hier,
 * sondern im Aufrufer, s. `editor-root.tsx#saveContent`: `TypeError`/Netz/5xx
 * → `'offline-error'`, `SessionExpiredError` → eigener Pfad, jeder andere
 * Fehler inkl. der `ok:false`-Konvertierung → weiterhin `'error'`). Anders
 * als `error` ist `offline` NICHT eingefroren: `dueAt()` liefert dort einen
 * automatischen Retry in `offlineRetryMs` (Spec: 30 s) — derselbe
 * Timer-Mechanismus in `editor-root.tsx`, der jeden `dueAt()`-Wert in einen
 * `setTimeout` übersetzt, holt den Nutzer damit ohne Zutun zurück, sobald der
 * Server wieder erreichbar ist; ein `online`-Browser-Event triggert dort
 * zusätzlich sofort `flushNow`. `onChange` ist in `offline` bewusst KEIN
 * No-Op (anders als `conflict`): eine neue Änderung setzt ganz normal auf
 * `dirty` zurück (Backoff-Zähler auf 0) — der Aufrufer erneuert dabei bei
 * jedem weiteren Fehlversuch den lokalen Offline-Puffer mit dem frischesten
 * Inhalt, „offline" ist also kein Freeze, sondern nur der sichtbare
 * Dauerzustand zwischen den Retry-Zyklen.
 */

export type AutosaveStatus = 'idle' | 'dirty' | 'saving' | 'conflict' | 'error' | 'offline'

/** Ergebnis eines abgeschlossenen Save-Versuchs, das der Aufrufer nach dem
 *  `saveDraft`-Aufruf an {@link Autosave.onSaveResult} zurückmeldet. Der
 *  409-Konflikt (`'conflict'`) ist wie in `client-api.ts#saveDraft` ein
 *  erwarteter Fall, kein Fehler. `'offline-error'` (Phase 4b Task 2) ist ein
 *  Fehlversuch, den der Aufrufer als Netzwerk-/5xx-Fehler klassifiziert hat
 *  — nach `maxAttempts` erreicht dieser Pfad `offline` statt `error` (s.
 *  Modulkommentar); vor `maxAttempts` verhält er sich identisch zu
 *  `'error'` (Backoff-Retry, Status `dirty`). */
export type SaveOutcome = 'ok' | 'conflict' | 'error' | 'offline-error'

export interface AutosaveSnapshot {
  status: AutosaveStatus
  /** Zeitpunkt des nächsten fälligen Saves, oder `null` außerhalb eines
   *  geplanten (Retry-)Debounce-Fensters — identisch zu {@link Autosave.dueAt}. */
  dueAt: number | null
  /** Anzahl der bisherigen Fehlversuche seit dem letzten Erfolg. Bis zum
   *  Erreichen von `maxAttempts` (Default 3) treibt dieser Zähler den Backoff;
   *  danach steht der Zustand auf `error` (eingefroren) ODER `offline`. Im
   *  Dauer-`offline`-Zustand zählt jeder fehlgeschlagene 30s-Retry weiter hoch
   *  (kann also `maxAttempts` übersteigen) — nur `onChange`/ein Erfolg setzt
   *  ihn auf 0 zurück. Reine Diagnose-/Anzeigegröße, keine Zustandslogik hängt
   *  am konkreten Wert oberhalb von `maxAttempts`. */
  attempt: number
}

export interface AutosaveOptions {
  /** Debounce-Fenster in ms zwischen der letzten Änderung und dem
   *  automatischen Save. Spec: ~30 s. */
  debounceMs?: number
  /** Maximale Anzahl an Fehlversuchen, bevor der sichtbare Fehlzustand
   *  („Änderungen nicht gespeichert") erreicht ist. Spec: 3. */
  maxAttempts?: number
  /** Backoff-Verzögerung vor dem n-ten Retry (`attempt` ist 1-basiert, der
   *  Wert NACH dem fehlgeschlagenen Versuch). Default: exponentiell
   *  (2s/4s/8s), gedeckelt. */
  backoffMs?: (attempt: number) => number
  /** Retry-Intervall im `offline`-Zustand (Phase 4b Task 2) — greift NACH
   *  erschöpftem Backoff (`maxAttempts` Netzwerk-/5xx-Fehlversuche), s.
   *  Modulkommentar. Spec: 30 s. */
  offlineRetryMs?: number
}

export interface Autosave {
  /** Meldet eine inhaltliche Änderung (z. B. `onDirty()` aus dem Editor).
   *  Reschedult das Debounce-Fenster auf `now + debounceMs`. Während eines
   *  laufenden Saves wird die Änderung nur vorgemerkt (Folge-Save nach
   *  Abschluss, kein Datenverlust) statt einen zweiten Save parallel zu
   *  starten. Während `conflict` ein No-Op (s. Modulkommentar). */
  onChange(now: number): void
  /** Zeitpunkt des nächsten fälligen automatischen Saves, oder `null` wenn
   *  gerade keiner ansteht (idle/saving/conflict/erschöpfter Fehlzustand).
   *  In `offline` (Phase 4b Task 2) liefert dies — anders als im
   *  eingefrorenen `error`-Endzustand — einen automatischen Retry-Zeitpunkt
   *  (s. Modulkommentar). */
  dueAt(): number | null
  /** Erzwingt einen sofortigen Save-Versuch (Moduswechsel, ⌘S, Verlassen,
   *  `online`-Event) — unabhängig vom Debounce-Fenster. Liefert `true`, wenn
   *  der Aufrufer jetzt tatsächlich speichern soll (Status wechselt auf
   *  `saving`); `false`, wenn gerade nichts zu speichern ist, bereits ein
   *  Save läuft (in-flight-Guard — die Änderung bleibt in dem Fall als
   *  Folge-Save vorgemerkt), ODER der Zustand `conflict` ist (Review-Fund 2
   *  — s. Modulkommentar; dafür ist {@link resolveConflict} da). Aus
   *  `offline` heraus IMMER erlaubt (manueller Retry). */
  flushNow(now: number): boolean
  /** Löst den eingefrorenen `conflict`-Zustand explizit auf — NUR vom
   *  Konflikt-Dialog aufgerufen ("Meine Fassung behalten"/"Serverstand
   *  übernehmen" mit erneutem Save). Anders als `flushNow` (das aus
   *  `conflict` heraus IMMER `false` liefert) ist dies die einzige
   *  verbleibende Fortsetzung aus dem eingefrorenen Zustand. Liefert
   *  `false`, wenn außerhalb von `conflict` aufgerufen (defensiv). */
  resolveConflict(now: number): boolean
  /** Meldet das Ergebnis eines Save-Versuchs zurück, der zuvor über
   *  `flushNow`/`resolveConflict`/eine fällige `dueAt`-Auslösung gestartet
   *  wurde. Außerhalb von `saving` ein defensives No-Op (kein Aufrufer sollte
   *  das tun, aber ein Doppel-Callback darf den Zustand nicht verfälschen). */
  onSaveResult(outcome: SaveOutcome, now: number): void
  /** Momentaufnahme für die UI (Statuszeile). */
  getStatus(): AutosaveSnapshot
}

const DEFAULT_DEBOUNCE_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_OFFLINE_RETRY_MS = 30_000

/** 2s, 4s, 8s (gedeckelt bei 8s) — exponentieller Standard-Backoff, falls
 *  kein eigener `backoffMs` übergeben wird. */
function defaultBackoffMs(attempt: number): number {
  return Math.min(2 ** attempt, 8) * 1000
}

export function createAutosave(options: AutosaveOptions = {}): Autosave {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = options.backoffMs ?? defaultBackoffMs
  const offlineRetryMs = options.offlineRetryMs ?? DEFAULT_OFFLINE_RETRY_MS

  let status: AutosaveStatus = 'idle'
  let due: number | null = null
  let attempt = 0
  /** Es kam eine Änderung herein, während ein Save bereits lief — nach
   *  dessen Abschluss folgt automatisch ein weiterer Save statt sie zu verlieren. */
  let pendingChangeDuringSave = false

  function onChange(now: number): void {
    if (status === 'conflict') return // eingefroren, s. Modulkommentar
    if (status === 'saving') {
      pendingChangeDuringSave = true
      return
    }
    attempt = 0
    status = 'dirty'
    due = now + debounceMs
  }

  function dueAt(): number | null {
    // `offline` liefert (anders als `error`) weiterhin einen fälligen
    // Zeitpunkt — der selbstheilende Retry-Zyklus, s. Modulkommentar.
    return status === 'dirty' || status === 'offline' ? due : null
  }

  function flushNow(now: number): boolean {
    if (status === 'saving') {
      // In-flight-Guard: kein paralleler Save. Die Änderung ist entweder
      // schon über onChange vorgemerkt oder es gibt (noch) keine — ein
      // expliziter Flush-Wunsch allein erzeugt keine neuen Daten zum
      // Speichern, also hier NICHT `pendingChangeDuringSave` erzwingen.
      return false
    }
    if (status === 'idle') return false // nichts zu speichern
    if (status === 'conflict') return false // eingefroren — s. resolveConflict()

    // dirty | error | offline → jetzt sofort speichern (offline: manueller
    // Retry ODER der `online`-Event-Handler in editor-root.tsx).
    status = 'saving'
    due = null
    pendingChangeDuringSave = false
    return true
  }

  function resolveConflict(now: number): boolean {
    if (status !== 'conflict') return false // defensiv: nur aus conflict gültig
    status = 'saving'
    due = null
    pendingChangeDuringSave = false
    return true
  }

  function onSaveResult(outcome: SaveOutcome, now: number): void {
    if (status !== 'saving') return // defensiv: nur aus einem laufenden Save gültig

    if (outcome === 'ok') {
      attempt = 0
      if (pendingChangeDuringSave) {
        pendingChangeDuringSave = false
        status = 'dirty'
        due = now + debounceMs
      } else {
        status = 'idle'
        due = null
      }
      return
    }

    if (outcome === 'conflict') {
      status = 'conflict'
      due = null
      pendingChangeDuringSave = false
      return
    }

    // outcome === 'error' | 'offline-error'
    pendingChangeDuringSave = false
    attempt += 1
    if (attempt >= maxAttempts) {
      if (outcome === 'offline-error') {
        // Selbstheilend statt eingefroren, s. Modulkommentar: automatischer
        // Retry alle `offlineRetryMs`, kein manuelles Eingreifen nötig.
        status = 'offline'
        due = now + offlineRetryMs
      } else {
        status = 'error'
        due = null
      }
      return
    }
    status = 'dirty'
    due = now + backoffMs(attempt)
  }

  function getStatus(): AutosaveSnapshot {
    return { status, dueAt: dueAt(), attempt }
  }

  return { onChange, dueAt, flushNow, resolveConflict, onSaveResult, getStatus }
}
