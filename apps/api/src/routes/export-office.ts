import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  ConvertError,
  ExportPageNotFoundError,
  F451Api,
  F451ApiError,
  NoTablesError,
  TooManyPagesError,
  exportOffice,
  type Converter,
} from '@f451/import'
import type { SpaceAccess } from '../auth/permissions.js'
import { requireBrowserSession } from '../auth/sessions.js'
import type { Db } from '../db/client.js'
import { pages } from '../db/schema.js'
import { OFFICE_CONTENT_TYPES, OFFICE_FORMATS, contentDisposition, type OfficeFormat } from '../export/office.js'
import type { JobRegistry, StartResult } from '../import/jobs.js'
import { exportFileRun, withJobToken } from '../import/run.js'
import type { SpaceConfig } from '../spaces/config.js'

export interface ExportOfficeDeps {
  db: Db
  spaces: readonly SpaceConfig[]
  access: SpaceAccess
  jobs: JobRegistry
  publicBaseUrl: string
  /** `fetch` against this app's own routes (`injectFetch`). */
  selfFetch: typeof fetch
  /** Convert client of the instant route; null → export not configured. */
  converter: Converter | null
  /** Convert client of the background job, with timeouts above the job's
   *  conversion timeout (`longTimeoutFetch`); null when `converter` is. */
  jobConverter: Converter | null
}

/** Limits of the instant download (spec §4); beyond them the panel export. */
export const INSTANT_MAX_PAGES = 200
export const INSTANT_TIMEOUT_MS = 120_000

const PANEL_HINT = 'Use the export in the import/export panel for large exports.'

const formatProperty = { type: 'string', enum: OFFICE_FORMATS } as const

const instantSchema = {
  tags: ['export'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  querystring: {
    type: 'object',
    properties: {
      format: formatProperty,
      subpages: { type: 'string', enum: ['0', '1', 'false', 'true'] },
    },
    required: ['format'],
  },
} as const

const jobSchema = {
  tags: ['export'],
  params: {
    type: 'object',
    properties: { space: { type: 'string' } },
    required: ['space'],
  },
  body: {
    type: 'object',
    properties: {
      pageId: { type: 'string', minLength: 1 },
      format: formatProperty,
      subpages: { type: 'boolean' },
    },
    required: ['pageId', 'format', 'subpages'],
    additionalProperties: false,
  },
} as const

const jobFileSchema = {
  tags: ['export'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
} as const

function notConfigured(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ status: 'bad_request', reason: 'export not configured' })
}

function pageNotFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ status: 'not_found', reason: `Page "${id}" is not known.` })
}

function startRefused(reply: FastifyReply, result: Exclude<StartResult, { ok: true }>): FastifyReply {
  if (result.reason === 'busy') {
    return reply
      .code(409)
      .send({ status: 'conflict', reason: 'You already have a running import or export.', jobId: result.id })
  }
  return reply.code(429).send({ status: 'rate_limited', reason: 'Too many imports or exports running, try again later.' })
}

/** The published page's space when the user may read it; null otherwise
 *  (unknown page, draft-only page, unknown or unreadable space — one answer). */
async function readableSpace(deps: ExportOfficeDeps, userId: string, pageId: string): Promise<SpaceConfig | null> {
  const row = (
    await deps.db
      .select({ spaceId: pages.spaceId })
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.ref, 'main')))
      .limit(1)
  )[0]
  if (!row) return null
  const space = deps.spaces.find((s) => s.id === row.spaceId)
  if (!space || !(await deps.access.canRead(userId, space))) return null
  return space
}

/** The caller's own API token when the request came with one (CLI, MCP). Its
 *  scope and classification limit then also apply to every page the export
 *  reads; a session caller gets a short-lived read token instead. */
function callerToken(req: FastifyRequest): string | null {
  if (req.apiTokenScope == null) return null
  const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
  return match ? match[1]! : null
}

/** `work`, or a rejection with the signal's reason once it aborts first. */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Known export failures → status and reason; anything else is rethrown (500). */
function exportErrorReply(reply: FastifyReply, err: unknown, pageId: string): FastifyReply {
  if (err instanceof TooManyPagesError) {
    return reply.code(413).send({ status: 'payload_too_large', reason: `${err.message}. ${PANEL_HINT}` })
  }
  if (err instanceof ExportPageNotFoundError) return pageNotFound(reply, pageId)
  if (err instanceof NoTablesError) {
    return reply.code(422).send({ status: 'unprocessable', reason: 'no tables to export' })
  }
  if (err instanceof ConvertError) {
    if (err.status === 504) {
      return reply.code(504).send({ status: 'timeout', reason: `The conversion timed out. ${PANEL_HINT}` })
    }
    const status = err.status === 413 ? 413 : 502
    return reply.code(status).send({ status: 'error', reason: `Convert service: ${err.message}` })
  }
  if (err instanceof F451ApiError && (err.status === 403 || err.status === 404)) {
    // A page of the export the caller's token may not read (classification
    // limit, #39), or one that vanished from the index meanwhile.
    return err.status === 403
      ? reply.code(403).send({
          status: 'forbidden',
          reason: 'A page of the export is not readable with this token (token_classification_limit).',
        })
      : pageNotFound(reply, pageId)
  }
  throw err
}

function sendFile(reply: FastifyReply, fileName: string, format: OfficeFormat, body: unknown): FastifyReply {
  return reply
    .header('content-type', OFFICE_CONTENT_TYPES[format])
    .header('content-disposition', contentDisposition(fileName))
    .header('cache-control', 'no-store')
    .send(body)
}

/**
 * Office export (spec 2026-10-16-office-export §1, §4): instant download of a
 * published page (and its subpages), the same as a background job, and the
 * job's result file. Read access to the space is enough; no access is a 404.
 */
export function registerExportOfficeRoutes(app: FastifyInstance, deps: ExportOfficeDeps): void {
  app.register(async (instance) => {
    // Open to API tokens on purpose: the CLI and the MCP tool use this route.
    instance.get<{ Params: { id: string }; Querystring: { format: OfficeFormat; subpages?: string } }>(
      '/api/pages/:id/export',
      { schema: instantSchema },
      async (req, reply) => {
        const converter = deps.converter
        if (!converter) return notConfigured(reply)
        const pageId = req.params.id
        const userId = req.user!.id
        const space = await readableSpace(deps, userId, pageId)
        if (!space) return pageNotFound(reply, pageId)

        const format = req.query.format
        const subpages = req.query.subpages === '1' || req.query.subpages === 'true'
        const signal = AbortSignal.timeout(INSTANT_TIMEOUT_MS)
        const run = (token: string) =>
          withDeadline(
            exportOffice(new F451Api('http://internal', token, deps.selfFetch), converter, {
              space: space.id,
              pageId,
              subpages,
              format,
              publicBaseUrl: deps.publicBaseUrl,
              maxPages: INSTANT_MAX_PAGES,
              signal,
            }),
            signal,
          )

        try {
          const token = callerToken(req)
          const out = token
            ? await run(token)
            : await withJobToken(deps.db, userId, 'read', `export-${randomUUID()}`, run)
          return sendFile(reply, out.fileName, format, Buffer.from(out.file.buffer, out.file.byteOffset, out.file.byteLength))
        } catch (err) {
          if (signal.aborted) {
            return reply.code(504).send({
              status: 'timeout',
              reason: `The export took longer than ${INSTANT_TIMEOUT_MS / 1000} s. ${PANEL_HINT}`,
            })
          }
          return exportErrorReply(reply, err, pageId)
        }
      },
    )

    instance.post<{ Params: { space: string }; Body: { pageId: string; format: OfficeFormat; subpages: boolean } }>(
      '/api/spaces/:space/export/file',
      { schema: jobSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const converter = deps.jobConverter
        if (!converter) return notConfigured(reply)
        const userId = req.user!.id
        const { pageId, format, subpages } = req.body
        const space = await readableSpace(deps, userId, pageId)
        // A page of another space is answered like an unknown one.
        if (!space || space.id !== req.params.space) return pageNotFound(reply, pageId)

        const result = deps.jobs.start(
          userId,
          'export-file',
          space.id,
          exportFileRun(
            { db: deps.db, selfFetch: deps.selfFetch, publicBaseUrl: deps.publicBaseUrl, converter },
            { userId, space: space.id, pageId, subpages, format },
          ),
        )
        if (!result.ok) return startRefused(reply, result)
        return reply.code(202).send({ jobId: result.id })
      },
    )

    instance.get<{ Params: { id: string } }>(
      '/api/jobs/:id/file',
      { schema: jobFileSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const file = deps.jobs.file(req.user!.id, req.params.id)
        // The file may expire between the lookup and the open: same 404.
        const handle = file ? await open(file.path, 'r').catch(() => null) : null
        if (!file || !handle) return reply.code(404).send({ status: 'not_found', reason: 'File not found.' })
        return reply
          .header('content-type', file.contentType)
          .header('content-disposition', contentDisposition(file.name))
          .header('cache-control', 'no-store')
          .send(handle.createReadStream())
      },
    )
  })
}
