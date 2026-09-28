import { describe, expect, it } from 'vitest'

import { ClientApiError, SessionExpiredError } from './client-api.js'
import { classifySaveFailure } from './save-failure.js'

describe('classifySaveFailure', () => {
  it('Netzwerkfehler (ClientApiError status 0) MIT gelungener Pufferung → offline-error', () => {
    const err = new ClientApiError(0, 'Netzwerkfehler')
    expect(classifySaveFailure(err, true)).toBe('offline-error')
  })

  it('Serverfehler (status >= 500) MIT gelungener Pufferung → offline-error', () => {
    expect(classifySaveFailure(new ClientApiError(502, 'Bad Gateway'), true)).toBe('offline-error')
    expect(classifySaveFailure(new ClientApiError(503, 'Service Unavailable'), true)).toBe('offline-error')
    expect(classifySaveFailure(new ClientApiError(500, 'Internal'), true)).toBe('offline-error')
  })

  it('Finding 1: Netz-/5xx-Fehler OHNE gelungene Pufferung (Quota/Private-Mode) → error, NICHT offline-error', () => {
    // Kernregel der Fix-Runde: ohne echte lokale Sicherung darf das Statusband
    // NICHT „Änderungen lokal" versprechen — sonst ist der Inhalt beim Reload weg.
    expect(classifySaveFailure(new ClientApiError(0, 'Netzwerkfehler'), false)).toBe('error')
    expect(classifySaveFailure(new ClientApiError(502, 'Bad Gateway'), false)).toBe('error')
  })

  it('SessionExpiredError (401) → error, unabhängig vom Pufferergebnis (Redirect läuft bereits)', () => {
    expect(classifySaveFailure(new SessionExpiredError(), true)).toBe('error')
    expect(classifySaveFailure(new SessionExpiredError(), false)).toBe('error')
  })

  it('nicht-transienter API-Fehler (z. B. 403) → error, auch bei gelungener Pufferung (kein Auto-Retry sinnvoll)', () => {
    expect(classifySaveFailure(new ClientApiError(403, 'Kein Schreibrecht'), true)).toBe('error')
    // 4xx generell nicht offline (nur 0 und >=500 sind transiente Netz-/Serverfehler).
    expect(classifySaveFailure(new ClientApiError(400, 'Bad Request'), true)).toBe('error')
    expect(classifySaveFailure(new ClientApiError(404, 'Not Found'), true)).toBe('error')
  })

  it('unbekannter Fehler (kein ClientApiError/SessionExpiredError) → error', () => {
    expect(classifySaveFailure(new Error('irgendwas'), true)).toBe('error')
    expect(classifySaveFailure('string', true)).toBe('error')
    expect(classifySaveFailure(undefined, true)).toBe('error')
  })
})
