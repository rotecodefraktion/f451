import { describe, expect, it } from 'vitest'
import { JobRegistry, type JobProgress, type JobResult, type JobRun } from '../src/import/jobs.js'

/**
 * A run the test controls. The registry attaches its settlement handler to the
 * returned promise inside `start()`, so awaiting `settled()` after `resolve`/`reject`
 * runs strictly after the registry has updated the job — no sleeping needed.
 */
function controlledRun() {
  let resolve!: (r: JobResult) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<JobResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  const state: { signal: AbortSignal | null; progress: JobProgress | null } = { signal: null, progress: null }
  const run: JobRun = (signal, progress) => {
    state.signal = signal
    state.progress = progress
    return promise
  }
  return {
    run,
    state,
    resolve,
    reject,
    settled: () => promise.then(() => undefined, () => undefined),
  }
}

function setup(opts: { maxRunning?: number; keepMs?: number } = {}) {
  const clock = { t: Date.UTC(2026, 9, 14, 12, 0, 0) }
  let n = 0
  const reg = new JobRegistry({ ...opts, now: () => clock.t, newId: () => `job-${++n}` })
  return { reg, clock }
}

describe('JobRegistry', () => {
  it('start/get round-trip', async () => {
    const { reg, clock } = setup()
    const r = controlledRun()
    const started = reg.start('u1', 'import-bookstack', 'docs', r.run)
    expect(started).toEqual({ ok: true, id: 'job-1' })

    const running = reg.get('u1', 'job-1')
    expect(running).toMatchObject({
      id: 'job-1', kind: 'import-bookstack', space: 'docs', status: 'running',
      startedAt: new Date(clock.t).toISOString(), finishedAt: null,
      total: 0, done: 0, events: [], counts: {}, report: null, phase: null,
    })

    r.state.progress!.start(2)
    r.state.progress!.phase('writing')
    r.state.progress!.page({ status: 'created', title: 'A', pageId: 'p1' })
    clock.t += 1000
    r.resolve({ report: '# Report\n', counts: { created: 1 } })
    await r.settled()

    expect(reg.get('u1', 'job-1')).toEqual({
      id: 'job-1', kind: 'import-bookstack', space: 'docs', status: 'done',
      startedAt: new Date(clock.t - 1000).toISOString(), finishedAt: new Date(clock.t).toISOString(),
      total: 2, done: 1, events: [{ status: 'created', title: 'A', pageId: 'p1' }],
      counts: { created: 1 }, report: '# Report\n', phase: 'writing',
    })
  })

  it('shows the latest phase and ignores phases after the job ended', async () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'export-bookstack', 'docs', r.run)
    expect(reg.get('u1', 'job-1')?.phase).toBeNull()

    r.state.progress!.phase('reading')
    expect(reg.get('u1', 'job-1')?.phase).toBe('reading')
    r.state.progress!.phase('placing')
    expect(reg.get('u1', 'job-1')?.phase).toBe('placing')

    r.resolve({ report: 'ok', counts: {} })
    await r.settled()
    r.state.progress!.phase('writing')
    expect(reg.get('u1', 'job-1')?.phase).toBe('placing')
  })

  it('another user gets null, as does an unknown id', () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'export-bookstack', 'docs', r.run)
    expect(reg.get('u2', 'job-1')).toBeNull()
    expect(reg.cancel('u2', 'job-1')).toBeNull()
    expect(r.state.signal!.aborted).toBe(false)
    expect(reg.get('u1', 'nope')).toBeNull()
  })

  it('second start for same user is 409 (busy with the running id)', () => {
    const { reg } = setup()
    reg.start('u1', 'import-bookstack', 'docs', controlledRun().run)
    const second = reg.start('u1', 'export-bookstack', 'other', controlledRun().run)
    expect(second).toEqual({ ok: false, reason: 'busy', id: 'job-1' })
  })

  it('a user can start again once the previous job finished', async () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'import-bookstack', 'docs', r.run)
    r.resolve({ report: 'ok', counts: {} })
    await r.settled()
    expect(reg.start('u1', 'import-bookstack', 'docs', controlledRun().run)).toEqual({ ok: true, id: 'job-2' })
  })

  it('fourth concurrent start (three users running) is full', () => {
    const { reg } = setup()
    for (const u of ['u1', 'u2', 'u3']) expect(reg.start(u, 'import-bookstack', 's', controlledRun().run).ok).toBe(true)
    expect(reg.start('u4', 'import-bookstack', 's', controlledRun().run)).toEqual({ ok: false, reason: 'full' })
  })

  it('cancel aborts the signal and the job ends as cancelled', async () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'import-bookstack', 'docs', r.run)
    const v = reg.cancel('u1', 'job-1')
    expect(v?.status).toBe('running')
    expect(r.state.signal!.aborted).toBe(true)

    r.resolve({ report: '# Cancelled\n', counts: { cancelled: 3 } })
    await r.settled()
    const end = reg.get('u1', 'job-1')
    expect(end?.status).toBe('cancelled')
    expect(end?.report).toBe('# Cancelled\n')
    expect(end?.counts).toEqual({ cancelled: 3 })
    expect(end?.finishedAt).not.toBeNull()

    // Cancelling a finished job leaves it unchanged.
    expect(reg.cancel('u1', 'job-1')).toEqual(end)
  })

  it('abortAll aborts every running job', () => {
    const { reg } = setup()
    const a = controlledRun()
    const b = controlledRun()
    reg.start('u1', 'import-bookstack', 's', a.run)
    reg.start('u2', 'export-bookstack', 's', b.run)
    reg.abortAll()
    expect(a.state.signal!.aborted).toBe(true)
    expect(b.state.signal!.aborted).toBe(true)
  })

  it('thrown error ends as failed with the message in the report', async () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'import-bookstack', 'docs', r.run)
    r.state.progress!.page({ status: 'created', title: 'A' })
    r.reject(new Error('BookStack unreachable'))
    await r.settled()
    const v = reg.get('u1', 'job-1')
    expect(v?.status).toBe('failed')
    expect(v?.report).toBe('# Job failed\n\nBookStack unreachable\n')
    expect(v?.counts).toEqual({})
    expect(v?.finishedAt).not.toBeNull()
  })

  it('caps events at the last 200 while done counts all', async () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'import-bookstack', 'docs', r.run)
    r.state.progress!.start(250)
    for (let i = 0; i < 250; i++) r.state.progress!.page({ status: 'created', title: `P${i}` })
    const v = reg.get('u1', 'job-1')!
    expect(v.done).toBe(250)
    expect(v.total).toBe(250)
    expect(v.events).toHaveLength(200)
    expect(v.events[0]!.title).toBe('P50')
    expect(v.events[199]!.title).toBe('P249')
  })

  it('drops a finished job after keepMs', async () => {
    const { reg, clock } = setup({ keepMs: 60_000 })
    const r = controlledRun()
    reg.start('u1', 'import-bookstack', 'docs', r.run)
    r.resolve({ report: 'ok', counts: {} })
    await r.settled()

    clock.t += 59_999
    expect(reg.get('u1', 'job-1')).not.toBeNull()
    clock.t += 1
    expect(reg.get('u1', 'job-1')).toBeNull()
    expect(reg.cancel('u1', 'job-1')).toBeNull()
  })

  it('never drops a running job, however old', () => {
    const { reg, clock } = setup({ keepMs: 1000 })
    reg.start('u1', 'import-bookstack', 'docs', controlledRun().run)
    clock.t += 10_000
    expect(reg.get('u1', 'job-1')?.status).toBe('running')
  })

  it('the view has no key other than those of JobView', async () => {
    const { reg } = setup()
    const r = controlledRun()
    reg.start('u1', 'import-bookstack', 'docs', r.run)
    r.state.progress!.page({ status: 'created', title: 'A', secret: 'x' } as never)
    const keys = ['counts', 'done', 'events', 'finishedAt', 'id', 'kind', 'phase', 'report', 'space', 'startedAt', 'status', 'total']
    expect(Object.keys(reg.get('u1', 'job-1')!).sort()).toEqual(keys)
    expect(Object.keys(reg.get('u1', 'job-1')!.events[0]!).sort()).toEqual(['status', 'title'])

    r.resolve({ report: 'ok', counts: {} })
    await r.settled()
    expect(Object.keys(reg.get('u1', 'job-1')!).sort()).toEqual(keys)
  })
})
