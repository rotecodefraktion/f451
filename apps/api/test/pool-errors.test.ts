import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { attachPoolErrorHandler } from '../src/db/pool-errors.js'

/**
 * Regression zu einem realen Produktionsausfall: Wird Postgres neu gestartet
 * (Docker-Neustart, Wartung, `pg_terminate_backend`), schickt der Server allen
 * offenen Verbindungen `57P01 — terminating connection due to administrator
 * command`. `pg-pool` gibt das als `'error'`-Event am Pool weiter. Ein
 * EventEmitter OHNE `'error'`-Listener wirft diesen Fehler als unbehandelte
 * Ausnahme — der API-Prozess starb daran mit Exit-Code 1 und kam nicht zurück.
 */
describe('Pool-Fehlerbehandlung', () => {
  const adminShutdown = () =>
    Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    })

  it('ohne Handler beendet ein Pool-Fehler den Prozess (Nachweis der Ursache)', () => {
    const pool = new EventEmitter()
    expect(() => pool.emit('error', adminShutdown())).toThrow(/terminating connection/)
  })

  it('mit Handler wird der Fehler protokolliert statt geworfen', () => {
    const pool = new EventEmitter()
    const error = vi.fn()

    attachPoolErrorHandler(pool, { error })

    expect(() => pool.emit('error', adminShutdown())).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    const [payload, message] = error.mock.calls[0] as [{ err: unknown }, string]
    expect(payload.err).toBeInstanceOf(Error)
    expect(message).toMatch(/Datenbank/i)
  })

  it('überlebt mehrere Fehler nacheinander (jede Verbindung meldet einzeln)', () => {
    // Ein Postgres-Neustart trifft ALLE Verbindungen des Pools gleichzeitig —
    // der Handler darf sich nicht nach dem ersten Fehler abmelden.
    const pool = new EventEmitter()
    const error = vi.fn()

    attachPoolErrorHandler(pool, { error })

    for (let i = 0; i < 5; i += 1) {
      expect(() => pool.emit('error', adminShutdown())).not.toThrow()
    }
    expect(error).toHaveBeenCalledTimes(5)
  })

  it('protokolliert auch einen Fehler ohne Error-Objekt, ohne selbst zu werfen', () => {
    const pool = new EventEmitter()
    const error = vi.fn()

    attachPoolErrorHandler(pool, { error })

    expect(() => pool.emit('error', 'kaputt')).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
  })
})
