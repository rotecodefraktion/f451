import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  BookStackClient,
  F451Api,
  exportOffice,
  exportToBookStack,
  importTree,
  loadBookStackTree,
  loadHtmlTree,
  loadMarkdownFolderTree,
  loadObsidianTree,
  loadOfficeTree,
  renderExportReport,
  renderReport,
  type BookStackSelector,
  type Converter,
  type FileSource,
  type ImportTree,
} from '@f451/import'
import { generateApiToken, generateSessionId, hashApiToken } from '../auth/crypto.js'
import type { Db } from '../db/client.js'
import { apiTokens } from '../db/schema.js'
import { OFFICE_CONTENT_TYPES, renderOfficeExportReport, type OfficeFormat } from '../export/office.js'
import type { JobEvent, JobProgress, JobResult, JobRun } from './jobs.js'

/**
 * Runners for import/export jobs started from the web UI (#128).
 *
 * A job talks to f451 exactly like the CLI does — through the HTTP API, with
 * a personal access token of the user — but without leaving the process:
 * `injectFetch` routes the requests through `app.inject`. The token is minted
 * for the job only and revoked when it ends, so every write still carries the
 * user's own rights and goes through the review workflow.
 *
 * BookStack credentials only live in the closures built here; nothing stores
 * or logs them.
 */

export type BookStackFactory = (url: string, tokenId: string, tokenSecret: string) => BookStackClient

export interface RunDeps {
  db: Db
  selfFetch: typeof fetch
  bookstack: BookStackFactory
  /** Absolute f451 base URL for links in exported pages ('' when unset). */
  publicBaseUrl: string
  /** Convert service client for `format=office`; null when `F451_CONVERT_URL` is unset. */
  converter: Converter | null
}

interface RunCommon {
  userId: string
  /** Allow-listed, normalised base URL. */
  instance: string
  tokenId: string
  tokenSecret: string
  space: string
  dryRun: boolean
}

export interface ImportParams extends RunCommon {
  source: BookStackSelector
  parentId?: string
  update: boolean
  release: boolean
}

/** Import of an uploaded ZIP (Markdown folder or Obsidian vault). The archive
 *  is already validated (`zipSource`); `cleanup` removes the upload's temp
 *  file and runs when the job ends, whatever the outcome. */
export interface FileImportParams {
  userId: string
  space: string
  format: 'markdown' | 'obsidian' | 'html' | 'office'
  /** `office` only: split text at H1, one page per slide and sheet. */
  split?: boolean
  /** `office` only: language of generated names (the space's language). */
  lang?: 'de' | 'en'
  source: FileSource
  cleanup: () => Promise<void>
  parentId?: string
  update: boolean
  release: boolean
  dryRun: boolean
}

export interface ExportParams extends RunCommon {
  pageId?: string
  bookId?: number
}

/** Office export of a page (and its subpages) to a temp file (spec 2026-10-16-office-export §4). */
export interface ExportFileParams {
  userId: string
  space: string
  pageId: string
  subpages: boolean
  format: OfficeFormat
}

export interface ExportFileDeps extends Pick<RunDeps, 'db' | 'selfFetch' | 'publicBaseUrl'> {
  /** Convert client whose `fetch` outlasts the job's conversion timeout. */
  converter: Converter
}

/** Per-conversion timeout the job passes to the convert service. */
export const EXPORT_JOB_TIMEOUT_S = 600

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const NO_BODY_STATUSES = new Set([204, 205, 304])

type InjectMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** A `fetch` that answers from the app's own routes via `app.inject`. Only the
 *  path and query of the URL are used; the host is ignored. */
export function injectFetch(app: FastifyInstance): typeof fetch {
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, 'http://internal')
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() as InjectMethod

    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })

    let payload: string | Buffer | undefined
    const body = init.body
    if (body instanceof FormData) {
      // Let undici serialise the multipart body and pick the boundary.
      const req = new Request('http://internal', { method, body })
      const contentType = req.headers.get('content-type')
      if (contentType) headers['content-type'] = contentType
      payload = Buffer.from(await req.arrayBuffer())
    } else if (typeof body === 'string') {
      payload = body
    } else if (body instanceof Uint8Array) {
      payload = Buffer.from(body)
    } else if (body !== undefined && body !== null) {
      throw new Error('injectFetch: unsupported body type')
    }

    const res = await app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(payload !== undefined ? { payload } : {}),
    })

    const outHeaders = new Headers()
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue
      outHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value))
    }
    const outBody = NO_BODY_STATUSES.has(res.statusCode) ? null : new Uint8Array(res.rawPayload)
    return new Response(outBody, { status: res.statusCode, headers: outHeaders })
  }
  return fetchImpl as typeof fetch
}

/** Mints a short-lived PAT for the job, hands it to `fn` and revokes it afterwards,
 *  whatever the outcome. The plaintext token never leaves this call. */
export async function withJobToken<T>(
  db: Db,
  userId: string,
  scope: 'read' | 'write',
  jobId: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const token = generateApiToken()
  const id = generateSessionId()
  await db.insert(apiTokens).values({
    id,
    userId,
    tokenHash: hashApiToken(token),
    label: `import job ${jobId}`,
    scope,
    maxClassification: 'strictly-confidential',
    expiresAt: new Date(Date.now() + DAY_MS),
  })
  try {
    return await fn(token)
  } finally {
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id))
  }
}

interface PageEventIn { status: string; title: string; pageId?: string; reason?: string }

function pageEvent(progress: JobProgress, e: PageEventIn, link: JobEvent['link']): void {
  progress.page({
    status: e.status,
    title: e.title,
    ...(e.pageId !== undefined ? { pageId: e.pageId } : {}),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    ...(link !== undefined ? { link } : {}),
  })
}

/** Where an imported page can be opened right after the run. Without release
 *  a new or changed page exists only as a draft with an open review; skipped
 *  pages are published unless their review is still open. Dry-run ids are
 *  placeholders, failed and cancelled pages have nothing to show. */
export function importEventLink(
  e: Pick<PageEventIn, 'status' | 'pageId' | 'reason'>,
  opts: { release: boolean; dryRun: boolean },
): JobEvent['link'] {
  if (!e.pageId || opts.dryRun) return undefined
  if (e.status === 'created' || e.status === 'updated') return opts.release ? 'page' : 'review'
  if (e.status === 'skipped') return e.reason?.includes('review still open') ? 'review' : 'page'
  return undefined
}

export function importRun(deps: RunDeps, p: ImportParams): JobRun {
  return async (signal, progress, jobId): Promise<JobResult> => {
    return withJobToken(deps.db, p.userId, 'write', jobId, async (token) => {
      const f451 = new F451Api('http://internal', token, deps.selfFetch)
      const bs = deps.bookstack(p.instance, p.tokenId, p.tokenSecret)
      progress.phase('reading')
      // Cancelling while reading stops the load; importTree then reports the
      // partial tree as cancelled (#142).
      const tree = await loadBookStackTree(bs, p.source, {
        baseUrl: p.instance,
        drawio: null,
        maxBytes: MAX_MEDIA_BYTES,
        signal,
      })
      return writeTree(tree, f451, p, signal, progress)
    })
  }
}

/** Writes a loaded tree through the API (drafts and reviews) and turns the
 *  writer's report into the job result. Shared by all import runners. */
async function writeTree(
  tree: ImportTree,
  f451: F451Api,
  p: { space: string; parentId?: string; update: boolean; release: boolean; dryRun: boolean },
  signal: AbortSignal,
  progress: JobProgress,
): Promise<JobResult> {
  const report = await importTree(
    tree,
    { space: p.space, ...(p.parentId ? { parentId: p.parentId } : {}) },
    f451,
    { update: p.update, release: p.release, dryRun: p.dryRun, signal },
    (e) => {
      if (e.kind === 'start') progress.start(e.pages)
      else if (e.kind === 'phase') progress.phase(e.phase)
      else if (e.kind === 'page') pageEvent(progress, e, importEventLink(e, p))
    },
  )
  return {
    report: renderReport(report),
    counts: {
      created: report.created.length,
      updated: report.updated.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
      cancelled: report.cancelled.length,
    },
  }
}

export function fileImportRun(deps: RunDeps, p: FileImportParams): JobRun {
  return async (signal, progress, jobId): Promise<JobResult> => {
    try {
      return await withJobToken(deps.db, p.userId, 'write', jobId, async (token) => {
        const f451 = new F451Api('http://internal', token, deps.selfFetch)
        progress.phase('reading')
        // The loaders take no signal (the archive is local); a cancel while
        // reading takes effect in importTree, which reports the pages as cancelled.
        let tree: ImportTree
        if (p.format === 'office') {
          if (!deps.converter) throw new Error('The convert service is not configured.')
          // Conversions run one by one; a cancel stops before the next file.
          try {
            tree = await loadOfficeTree(p.source, {
              converter: deps.converter,
              split: p.split === true,
              lang: p.lang ?? 'de',
              signal,
            })
          } catch (err) {
            // The loader throws when cancelled between two conversions; the
            // registry turns a settled job with an aborted signal into `cancelled`.
            if (signal.aborted) return { report: '# Import report\n\nCancelled while converting.\n', counts: { cancelled: 0 } }
            throw err
          }
        } else {
          tree =
            p.format === 'obsidian'
              ? await loadObsidianTree(p.source)
              : p.format === 'html'
                ? await loadHtmlTree(p.source)
                : await loadMarkdownFolderTree(p.source)
        }
        return writeTree(tree, f451, p, signal, progress)
      })
    } finally {
      await p.cleanup()
    }
  }
}

export function exportRun(deps: RunDeps, p: ExportParams): JobRun {
  return async (signal, progress, jobId): Promise<JobResult> => {
    return withJobToken(deps.db, p.userId, 'read', jobId, async (token) => {
      const f451 = new F451Api('http://internal', token, deps.selfFetch)
      const bs = deps.bookstack(p.instance, p.tokenId, p.tokenSecret)
      const report = await exportToBookStack(
        f451,
        bs,
        {
          space: p.space,
          ...(p.pageId ? { startPageId: p.pageId } : {}),
          ...(p.bookId !== undefined ? { bookId: p.bookId } : {}),
          dryRun: p.dryRun,
          f451Url: deps.publicBaseUrl,
          bookstackUrl: p.instance,
          signal,
        },
        (e) => {
          if (e.kind === 'start') progress.start(e.pages)
          else if (e.kind === 'phase') progress.phase(e.phase)
          else if (e.kind === 'page') pageEvent(progress, { status: e.status, title: e.name, pageId: e.pageId, reason: e.reason }, 'page')
        },
      )
      return {
        report: renderExportReport(report),
        counts: {
          created: report.created.length,
          updated: report.updated.length,
          failed: report.failed.length,
          cancelled: report.cancelled.length,
        },
      }
    })
  }
}

const EXPORT_CANCELLED: JobResult = { report: '# Export report\n\nCancelled.\n', counts: { cancelled: 0 } }

/**
 * Background Office export: no page limit, the long conversion timeout, the
 * result written to `os.tmpdir()/f451-export-<uuid>.<ext>`. The registry owns
 * the file from settlement on. A cancel stops before the conversion; one that
 * arrives during the conversion still leaves no file behind.
 */
export function exportFileRun(deps: ExportFileDeps, p: ExportFileParams): JobRun {
  return async (signal, progress, jobId): Promise<JobResult> => {
    progress.phase('exporting')
    let out: Awaited<ReturnType<typeof exportOffice>>
    try {
      out = await withJobToken(deps.db, p.userId, 'read', jobId, (token) =>
        exportOffice(new F451Api('http://internal', token, deps.selfFetch), deps.converter, {
          space: p.space,
          pageId: p.pageId,
          subpages: p.subpages,
          format: p.format,
          publicBaseUrl: deps.publicBaseUrl,
          timeoutS: EXPORT_JOB_TIMEOUT_S,
          signal,
        }),
      )
    } catch (err) {
      // exportOffice throws the abort reason when cancelled between pages or
      // before the conversion; the registry marks the job `cancelled`.
      if (signal.aborted) return EXPORT_CANCELLED
      throw err
    }
    if (signal.aborted) return EXPORT_CANCELLED

    const path = join(tmpdir(), `f451-export-${randomUUID()}.${p.format}`)
    try {
      await writeFile(path, out.file)
    } catch (err) {
      await rm(path, { force: true }).catch(() => undefined)
      throw err
    }
    return {
      report: renderOfficeExportReport(out.fileName, out.report),
      counts: { pages: out.report.pages },
      file: { path, name: out.fileName, contentType: OFFICE_CONTENT_TYPES[p.format] },
    }
  }
}
