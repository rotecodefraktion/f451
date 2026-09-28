import { describe, expect, it } from 'vitest'
import { createAutosave } from './autosave.js'

const DEBOUNCE_MS = 30_000

describe('createAutosave', () => {
  it('Regressionsschutz Save-Button Mangel 1: ein frisch erzeugter Autosave ist "idle" — NUR eine echte onChange-Meldung darf auf "dirty" wechseln', () => {
    // Die Wurzelursache des Bugs (Speichern-Button vor jeder Eingabe fälschlich
    // aktiv) lag NICHT hier: `status-bar.tsx#saveDisabled` verlässt sich darauf,
    // dass `saveStatus === 'idle'` genau dann gilt, wenn nichts zu speichern
    // ansteht — diese State-Machine selbst kannte diesen Bug nie (sie hat gar
    // keinen „dirty beim Erzeugen"-Pfad). Der tatsächliche Fehler saß in der
    // React-/Tiptap-Verdrahtung (`wysiwyg-editor.tsx`: `Editor#setEditable`
    // emittiert per Tiptap-Default IMMER ein synthetisches `"update"`-Event,
    // auch ohne Dokumentänderung, das direkt nach dem Mount `onDirty()` und
    // damit `onChange()` HIER auslöste). Dieser Test verankert trotzdem die
    // Invariante, auf der der Fix beruht — jede künftige Änderung an dieser
    // Datei darf sie nicht brechen.
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    expect(autosave.getStatus().status).toBe('idle')
    expect(autosave.dueAt()).toBeNull()

    autosave.onChange(0)
    expect(autosave.getStatus().status).toBe('dirty')
  })

  it('plant einen Save 30s nach einer Änderung (debounced)', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)

    expect(autosave.dueAt()).toBe(DEBOUNCE_MS)
    expect(autosave.getStatus().status).toBe('dirty')
  })

  it('Tipp-Sturm verschiebt den fälligen Zeitpunkt immer weiter nach hinten — am Ende genau EIN fälliger Save', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    // Zehn Änderungen im Sekundentakt, alle deutlich innerhalb des Debounce-Fensters.
    for (let t = 0; t <= 9000; t += 1000) {
      autosave.onChange(t)
      // Während des Tippsturms ist der fällige Zeitpunkt immer noch in der Zukunft —
      // ein naiver "jetzt >= dueAt"-Timer würde hier NIE auslösen.
      expect(autosave.dueAt()!).toBeGreaterThan(t)
    }

    const lastChangeAt = 9000
    expect(autosave.dueAt()).toBe(lastChangeAt + DEBOUNCE_MS)

    // Ein timer-getriebener Hook plant seinen Timeout aus `dueAt()` und setzt ihn bei
    // jedem `onChange` neu — jeder der neun früheren `dueAt()`-Werte aus der Schleife
    // oben wurde dadurch verworfen, bevor er je feuern konnte (s. Assertion in der
    // Schleife: `dueAt()` lag während des ganzen Sturms immer in der Zukunft). Erst
    // der EINE, finale Timeout auf den letzten `dueAt()`-Wert feuert tatsächlich und
    // startet GENAU EINEN Save.
    const dueNow = lastChangeAt + DEBOUNCE_MS
    expect(autosave.flushNow(dueNow)).toBe(true)
    expect(autosave.getStatus().status).toBe('saving')

    // Ein zweiter Versuch während des laufenden Saves darf NICHT parallel starten.
    expect(autosave.flushNow(dueNow + 10)).toBe(false)
    expect(autosave.getStatus().status).toBe('saving')
  })

  it('Änderung während eines laufenden Saves (in-flight) führt zu einem Folge-Save statt Datenverlust', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    expect(autosave.flushNow(0)).toBe(true) // saving

    // Nutzer tippt weiter, während der Save noch unterwegs ist.
    autosave.onChange(500)
    expect(autosave.getStatus().status).toBe('saving') // noch kein zweiter Save parallel
    expect(autosave.dueAt()).toBeNull() // kein eigener Timer während des in-flight Saves

    autosave.onSaveResult('ok', 1000)

    // Die Änderung während des Saves darf nicht verloren gehen — erneut dirty,
    // mit frisch gestartetem Debounce-Fenster ab dem Save-Ende.
    expect(autosave.getStatus().status).toBe('dirty')
    expect(autosave.dueAt()).toBe(1000 + DEBOUNCE_MS)
  })

  it('ein erfolgreicher Save ohne Änderungen währenddessen geht zurück auf idle', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('ok', 100)

    expect(autosave.getStatus().status).toBe('idle')
    expect(autosave.dueAt()).toBeNull()
  })

  it('ein 409-Konflikt friert weitere Auto-Saves ein, bis der Konflikt-Dialog ihn auflöst', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('conflict', 100)

    expect(autosave.getStatus().status).toBe('conflict')
    expect(autosave.dueAt()).toBeNull()

    // Weitere Tastatureingaben während des eingefrorenen Konflikts planen KEINEN
    // automatischen Save — der Dialog ist die einzige Fortsetzung.
    autosave.onChange(200)
    autosave.onChange(5000)
    expect(autosave.getStatus().status).toBe('conflict')
    expect(autosave.dueAt()).toBeNull()

    // Die einzige Fortsetzung: `resolveConflict` aus dem Konflikt-Dialog heraus
    // (s. eigener Testfall unten). `flushNow` bleibt in `conflict` IMMER eingefroren.
    expect(autosave.flushNow(6000)).toBe(false)
    expect(autosave.getStatus().status).toBe('conflict')
  })

  it('Review-Fund 2: flushNow bleibt aus "conflict" heraus IMMER eingefroren (⌘S-Schutz) — nur resolveConflict löst auf', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('conflict', 100)
    expect(autosave.getStatus().status).toBe('conflict')

    // Ein globaler ⌘S-Handler, der den conflict-Status NICHT selbst prüft, ruft
    // trotzdem flushNow auf — die State-Machine muss das allein abfangen (Defense
    // in Depth zusätzlich zum früh returnenden Handler in editor-root.tsx).
    expect(autosave.flushNow(200)).toBe(false)
    expect(autosave.getStatus().status).toBe('conflict')
    expect(autosave.flushNow(9999)).toBe(false)
    expect(autosave.getStatus().status).toBe('conflict')

    // Die einzige Fortsetzung: der Konflikt-Dialog ruft explizit resolveConflict.
    expect(autosave.resolveConflict(10_000)).toBe(true)
    expect(autosave.getStatus().status).toBe('saving')
  })

  it('resolveConflict ist außerhalb von "conflict" defensiv ein No-Op (liefert false)', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    expect(autosave.getStatus().status).toBe('idle')
    expect(autosave.resolveConflict(0)).toBe(false)
    expect(autosave.getStatus().status).toBe('idle')

    autosave.onChange(0)
    expect(autosave.getStatus().status).toBe('dirty')
    expect(autosave.resolveConflict(100)).toBe(false)
    expect(autosave.getStatus().status).toBe('dirty')
  })

  it('flushNow speichert sofort, auch bevor die Debounce-Zeit erreicht ist (Moduswechsel/⌘S/Verlassen)', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    expect(autosave.dueAt()).toBe(DEBOUNCE_MS)

    expect(autosave.flushNow(100)).toBe(true)
    expect(autosave.getStatus().status).toBe('saving')
    expect(autosave.dueAt()).toBeNull()
  })

  it('flushNow ohne ausstehende Änderungen tut nichts (nichts zu speichern)', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    expect(autosave.getStatus().status).toBe('idle')
    expect(autosave.flushNow(0)).toBe(false)
    expect(autosave.getStatus().status).toBe('idle')
  })

  it('Backoff nach Fehlern (Netz/502) endet nach 3 Versuchen im sichtbaren Fehlzustand', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('error', 100)

    expect(autosave.getStatus().status).toBe('dirty') // Retry geplant
    expect(autosave.getStatus().attempt).toBe(1)
    const retry1DueAt = autosave.dueAt()
    expect(retry1DueAt).not.toBeNull()

    expect(autosave.flushNow(retry1DueAt!)).toBe(true)
    autosave.onSaveResult('error', retry1DueAt! + 50)
    expect(autosave.getStatus().status).toBe('dirty')
    expect(autosave.getStatus().attempt).toBe(2)
    const retry2DueAt = autosave.dueAt()!

    expect(autosave.flushNow(retry2DueAt)).toBe(true)
    autosave.onSaveResult('error', retry2DueAt + 50)

    // Dritter Fehlversuch erschöpft den Backoff (max 3) — sichtbarer Fehlzustand,
    // kein weiterer automatischer Save mehr geplant.
    expect(autosave.getStatus().status).toBe('error')
    expect(autosave.getStatus().attempt).toBe(3)
    expect(autosave.dueAt()).toBeNull()
  })

  it('aus dem Fehlzustand ist ein manueller Retry über flushNow weiterhin möglich', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('error', due + 50)
    expect(autosave.getStatus().status).toBe('error')

    expect(autosave.flushNow(due + 100)).toBe(true)
    expect(autosave.getStatus().status).toBe('saving')

    autosave.onSaveResult('ok', due + 200)
    expect(autosave.getStatus().status).toBe('idle')
    expect(autosave.getStatus().attempt).toBe(0)
  })

  it('eine neue Änderung nach einem Fehlzustand setzt den Backoff-Zähler zurück und plant normal', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('error', due + 50)
    expect(autosave.getStatus().status).toBe('error')

    autosave.onChange(due + 1000)
    expect(autosave.getStatus().status).toBe('dirty')
    expect(autosave.getStatus().attempt).toBe(0)
    expect(autosave.dueAt()).toBe(due + 1000 + DEBOUNCE_MS)
  })

  it('onSaveResult außerhalb von "saving" ist defensiv ein No-Op', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS })

    autosave.onSaveResult('ok', 0)
    expect(autosave.getStatus().status).toBe('idle')
  })

  // --- Phase 4b Task 2: Offline-Resilienz ---------------------------------

  const OFFLINE_RETRY_MS = 30_000

  it('Netz-/5xx-Fehler (offline-error) führen nach maxAttempts in den Zustand "offline" — NICHT "error"', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('offline-error', 100)
    expect(autosave.getStatus().status).toBe('dirty') // Retry geplant, wie beim regulären Fehlzustand
    expect(autosave.getStatus().attempt).toBe(1)

    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    expect(autosave.getStatus().status).toBe('dirty')
    expect(autosave.getStatus().attempt).toBe(2)

    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)

    // Dritter Fehlversuch erschöpft den Backoff — aber NETZ-/5xx-Fehler landen im
    // selbstheilenden `offline`-Zustand statt im manuellen `error`-Endzustand.
    expect(autosave.getStatus().status).toBe('offline')
    expect(autosave.getStatus().attempt).toBe(3)
  })

  it('im offline-Zustand liefert dueAt() einen Retry in 30s nach Eintritt', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('offline-error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)

    expect(autosave.getStatus().status).toBe('offline')
    expect(autosave.dueAt()).toBe(due + 50 + OFFLINE_RETRY_MS)
  })

  it('flushNow ist im offline-Zustand erlaubt (manueller Retry, z. B. "online"-Event oder Nutzerklick)', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('offline-error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    expect(autosave.getStatus().status).toBe('offline')

    expect(autosave.flushNow(due + 100)).toBe(true)
    expect(autosave.getStatus().status).toBe('saving')
  })

  it('onChange im offline-Zustand ist AKTIV (kein Freeze wie bei conflict) und setzt normal auf dirty', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('offline-error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    expect(autosave.getStatus().status).toBe('offline')

    // Weitertippen während offline: anders als bei `conflict` (Freeze) bleibt
    // `onChange` hier aktiv — der nächste reguläre Save-Zyklus (Backoff-Zähler
    // zurückgesetzt) sichert den neuen Stand UND lässt den Aufrufer den
    // lokalen Puffer mit dem frischen Inhalt erneuern.
    autosave.onChange(due + 1000)
    expect(autosave.getStatus().status).toBe('dirty')
    expect(autosave.getStatus().attempt).toBe(0)
    expect(autosave.dueAt()).toBe(due + 1000 + DEBOUNCE_MS)
  })

  it('ein erfolgreicher Save verlässt den offline-Zustand → idle (der Aufrufer räumt den lokalen Puffer)', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('offline-error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('offline-error', due + 50)
    expect(autosave.getStatus().status).toBe('offline')

    autosave.flushNow(due + 100) // manueller/"online"-Retry
    autosave.onSaveResult('ok', due + 200)

    expect(autosave.getStatus().status).toBe('idle')
    expect(autosave.getStatus().attempt).toBe(0)
    expect(autosave.dueAt()).toBeNull()
  })

  it('ok:false-Konvertierungsfehler (Aufrufer meldet weiterhin "error") landen weiterhin im sichtbaren Fehlzustand — NICHT offline', () => {
    // Regressionsschutz für den harten Vertrag: die Machine unterscheidet nur nach
    // dem vom Aufrufer klassifizierten `SaveOutcome` — 'error' bleibt 'error'.
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('error', 100)
    let due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('error', due + 50)
    due = autosave.dueAt()!
    autosave.flushNow(due)
    autosave.onSaveResult('error', due + 50)

    expect(autosave.getStatus().status).toBe('error')
    expect(autosave.dueAt()).toBeNull() // kein automatischer 30s-Retry im "error"-Zustand
  })

  it('Conflict-Freeze-Regression bleibt unverändert, auch nach Ergänzung des offline-Zustands', () => {
    const autosave = createAutosave({ debounceMs: DEBOUNCE_MS, offlineRetryMs: OFFLINE_RETRY_MS })

    autosave.onChange(0)
    autosave.flushNow(0)
    autosave.onSaveResult('conflict', 100)

    expect(autosave.getStatus().status).toBe('conflict')
    expect(autosave.dueAt()).toBeNull()
    autosave.onChange(200)
    expect(autosave.getStatus().status).toBe('conflict') // weiterhin eingefroren
    expect(autosave.flushNow(300)).toBe(false)
    expect(autosave.resolveConflict(400)).toBe(true)
    expect(autosave.getStatus().status).toBe('saving')
  })
})
