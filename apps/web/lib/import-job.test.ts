import { describe, expect, it } from 'vitest'
import { eventHref, nextState, progressPercent, reportFileName, storageKey, type JobView, type PanelState } from './import-job.js'

function view(over: Partial<JobView> = {}): JobView {
  return {
    id: 'j1',
    kind: 'import-bookstack',
    space: 'demo',
    status: 'running',
    startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: null,
    total: 10,
    done: 3,
    events: [],
    counts: {},
    report: null,
    phase: null,
    ...over,
  }
}

const running: PanelState = { kind: 'running', jobId: 'j1', view: null }

describe('nextState', () => {
  it('404 resets a running panel to the form', () => {
    expect(nextState(running, { status: 404 })).toEqual({ kind: 'form' })
  })

  it('200 with a running job stays running and carries the view', () => {
    const v = view()
    expect(nextState(running, { status: 200, view: v })).toEqual({ kind: 'running', jobId: 'j1', view: v })
  })

  it.each(['done', 'failed', 'cancelled'] as const)('200 with %s finishes', (status) => {
    const v = view({ status, finishedAt: '2026-10-14T10:01:00.000Z', report: '# Import report\n' })
    expect(nextState(running, { status: 200, view: v })).toEqual({ kind: 'finished', view: v })
  })

  it('a transient error keeps the previous state', () => {
    expect(nextState(running, { status: 'error' })).toBe(running)
    const form: PanelState = { kind: 'form' }
    expect(nextState(form, { status: 'error' })).toBe(form)
  })
})

describe('progressPercent', () => {
  it('is 0 while the total is 0', () => {
    expect(progressPercent(view({ total: 0, done: 0 }))).toBe(0)
  })

  it('rounds and clamps to 0..100', () => {
    expect(progressPercent(view({ total: 3, done: 1 }))).toBe(33)
    expect(progressPercent(view({ total: 2, done: 5 }))).toBe(100)
  })
})

describe('storageKey and reportFileName', () => {
  it('keys the stored job id by space', () => {
    expect(storageKey('demo')).toBe('f451:import-job:demo')
  })

  it('names the report by job kind', () => {
    expect(reportFileName('import-bookstack')).toBe('import-report.md')
    expect(reportFileName('export-bookstack')).toBe('export-report.md')
  })
})

describe('eventHref', () => {
  it('follows the link the API chose for the event', () => {
    expect(eventHref('demo', { status: 'created', title: 'A', pageId: 'p-a', link: 'review' })).toBe('/wiki/demo/p-a/review')
    expect(eventHref('demo', { status: 'skipped', title: 'A', pageId: 'p-a', link: 'page' })).toBe('/wiki/demo/p-a')
  })
  it('has no link without a link target or a page id', () => {
    expect(eventHref('demo', { status: 'created', title: 'A', pageId: 'dry-3' })).toBeNull()
    expect(eventHref('demo', { status: 'failed', title: 'A', link: 'page' })).toBeNull()
  })
})
