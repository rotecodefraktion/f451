import { EventEmitter } from 'node:events'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '../src/db/client.js'
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

  it('createDb attaches the handler to its own pool (tests, migrate CLI)', async () => {
    // Unreachable target; pg.Pool connects lazily, so nothing is dialled here.
    const error = vi.fn()
    const handle = createDb('postgres://nobody@127.0.0.1:1/none', { error })
    try {
      expect(handle.pool).toBeInstanceOf(pg.Pool)
      const pool = handle.pool as pg.Pool
      expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1)
      expect(() => pool.emit('error', adminShutdown())).not.toThrow()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      await handle.close()
    }
  })
})
