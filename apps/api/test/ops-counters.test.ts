import { describe, expect, it } from 'vitest'
import { createOpsCounters } from '../src/ops/counters.js'

describe('createOpsCounters (Task 5, Betrieb)', () => {
  it('startet bei 0/0/0, since ist der Erzeugungszeitpunkt (injizierbares now)', () => {
    const fixedNow = new Date('2026-01-01T00:00:00.000Z')
    const counters = createOpsCounters(() => fixedNow)
    expect(counters.snapshot()).toEqual({
      webhookErrors: 0,
      indexerErrors: 0,
      driftErrors: 0,
      since: '2026-01-01T00:00:00.000Z',
    })
  })

  it('increment erhöht NUR den benannten Zähler, since bleibt unverändert', () => {
    const counters = createOpsCounters(() => new Date('2026-01-01T00:00:00.000Z'))
    counters.increment('webhook_errors')
    counters.increment('webhook_errors')
    counters.increment('indexer_errors')
    counters.increment('drift_errors')
    counters.increment('drift_errors')
    counters.increment('drift_errors')
    expect(counters.snapshot()).toEqual({
      webhookErrors: 2,
      indexerErrors: 1,
      driftErrors: 3,
      since: '2026-01-01T00:00:00.000Z',
    })
  })

  it('zwei Instanzen zählen unabhängig voneinander', () => {
    const a = createOpsCounters()
    const b = createOpsCounters()
    a.increment('webhook_errors')
    expect(a.snapshot().webhookErrors).toBe(1)
    expect(b.snapshot().webhookErrors).toBe(0)
  })
})
