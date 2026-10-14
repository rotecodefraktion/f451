import { randomUUID } from 'node:crypto'

/**
 * In-memory registry for import and export jobs started from the web UI.
 *
 * Jobs live only in this API process: a restart drops them, and the UI treats
 * the resulting 404 as "job gone". Nothing here is derivable from Git, and
 * nothing here needs to survive — the report is the only lasting artefact and
 * the user sees it while the job is kept.
 */

export type JobKind = 'import-bookstack' | 'export-bookstack'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'
/** `link`: where `pageId` can be opened now — the published page or its open review. */
export interface JobEvent { status: string; title: string; pageId?: string; reason?: string; link?: 'page' | 'review' }
export interface JobView {
  id: string; kind: JobKind; space: string; status: JobStatus
  startedAt: string; finishedAt: string | null
  total: number; done: number; events: JobEvent[]
  counts: Record<string, number>; report: string | null
  /** The runner's current phase (e.g. `reading`, `writing`); null until the first one. */
  phase: string | null
}
export interface JobProgress { start(total: number): void; page(e: JobEvent): void; phase(name: string): void }
export interface JobResult { report: string; counts: Record<string, number> }
/** `id` is the job's own id (used e.g. to label the job token). */
export type JobRun = (signal: AbortSignal, progress: JobProgress, id: string) => Promise<JobResult>
export type StartResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'busy'; id: string }
  | { ok: false; reason: 'full' }

const MAX_EVENTS = 200
const DEFAULT_MAX_RUNNING = 3
const DEFAULT_KEEP_MS = 24 * 60 * 60 * 1000

interface Job {
  id: string
  userId: string
  kind: JobKind
  space: string
  status: JobStatus
  startedAt: number
  finishedAt: number | null
  total: number
  done: number
  events: JobEvent[]
  counts: Record<string, number>
  report: string | null
  phase: string | null
  controller: AbortController
  /** Resolves once the run has settled and the record is updated; never rejects. */
  settled: Promise<void>
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>()
  private readonly maxRunning: number
  private readonly keepMs: number
  private readonly now: () => number
  private readonly newId: () => string

  constructor(opts: { maxRunning?: number; keepMs?: number; now?: () => number; newId?: () => string } = {}) {
    this.maxRunning = opts.maxRunning ?? DEFAULT_MAX_RUNNING
    this.keepMs = opts.keepMs ?? DEFAULT_KEEP_MS
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? randomUUID
  }

  start(userId: string, kind: JobKind, space: string, run: JobRun): StartResult {
    this.prune()
    let running = 0
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      if (job.userId === userId) return { ok: false, reason: 'busy', id: job.id }
      running++
    }
    if (running >= this.maxRunning) return { ok: false, reason: 'full' }

    const job: Job = {
      id: this.newId(),
      userId,
      kind,
      space,
      status: 'running',
      startedAt: this.now(),
      finishedAt: null,
      total: 0,
      done: 0,
      events: [],
      counts: {},
      report: null,
      phase: null,
      controller: new AbortController(),
      settled: Promise.resolve(),
    }
    this.jobs.set(job.id, job)

    const progress: JobProgress = {
      start: (total) => {
        if (job.status === 'running') job.total = total
      },
      page: (e) => {
        if (job.status !== 'running') return
        job.done++
        job.events.push(copyEvent(e))
        if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS)
      },
      phase: (name) => {
        if (job.status === 'running') job.phase = name
      },
    }

    const signal = job.controller.signal
    let promise: Promise<JobResult>
    try {
      promise = Promise.resolve(run(signal, progress, job.id))
    } catch (e) {
      promise = Promise.reject(e)
    }
    // Not awaited: the job runs in the background, its settlement updates the record.
    // Kept so that shutdown() can wait for it.
    job.settled = promise.then(
      (result) => {
        job.status = signal.aborted ? 'cancelled' : 'done'
        job.report = result.report
        job.counts = { ...result.counts }
        job.finishedAt = this.now()
      },
      (e: unknown) => {
        job.status = 'failed'
        job.report = `# Job failed\n\n${e instanceof Error ? e.message : String(e)}\n`
        job.counts = {}
        job.finishedAt = this.now()
      },
    )

    return { ok: true, id: job.id }
  }

  /** null: unknown, expired, or another user's job (deliberately indistinguishable). */
  get(userId: string, id: string): JobView | null {
    this.prune()
    const job = this.jobs.get(id)
    return job && job.userId === userId ? view(job) : null
  }

  /** Aborts the job if it is running; the view is returned unchanged otherwise. */
  cancel(userId: string, id: string): JobView | null {
    this.prune()
    const job = this.jobs.get(id)
    if (!job || job.userId !== userId) return null
    if (job.status === 'running') job.controller.abort()
    return view(job)
  }

  /** App shutdown: abort every running job. */
  abortAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller.abort()
    }
  }

  /**
   * App shutdown: abort every running job and wait until their runs have settled
   * (so their `finally` blocks, e.g. revoking the job token, still reach the
   * database), but no longer than `timeoutMs`.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const pending: Promise<void>[] = []
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      job.controller.abort()
      pending.push(job.settled)
    }
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([Promise.all(pending).then(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt >= this.keepMs) this.jobs.delete(id)
    }
  }
}

function copyEvent(e: JobEvent): JobEvent {
  return {
    status: e.status,
    title: e.title,
    ...(e.pageId !== undefined ? { pageId: e.pageId } : {}),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    ...(e.link !== undefined ? { link: e.link } : {}),
  }
}

function view(job: Job): JobView {
  return {
    id: job.id,
    kind: job.kind,
    space: job.space,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
    total: job.total,
    done: job.done,
    events: job.events.map(copyEvent),
    counts: { ...job.counts },
    report: job.report,
    phase: job.phase,
  }
}
