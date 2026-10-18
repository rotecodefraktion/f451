import { createWriteStream, type WriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type {} from '@fastify/multipart'
import {
  ArchiveRejectedError,
  BookStackApiError,
  OFFICE_EXTENSIONS,
  hasWordOptions,
  parseWordOptions,
  zipSource,
  type BookStackSelector,
  type Converter,
  type FileSource,
  type WordOptions,
} from '@f451/import'
import { requireBrowserSession } from '../auth/sessions.js'
import type { Db } from '../db/client.js'
import { findInstance } from '../import/instances.js'
import type { JobRegistry, StartResult } from '../import/jobs.js'
import { exportRun, fileImportRun, importRun, type BookStackFactory, type RunDeps } from '../import/run.js'
import type { TempFiles } from '../import/temp-files.js'
import { resolveNewPageWriteContext, type NewPageGateDeps } from './drafts.js'

/** Upload limit of the file import when `F451_IMPORT_MAX_UPLOAD_MB` is unset. */
export const DEFAULT_IMPORT_MAX_UPLOAD_MB = 200

export interface ImportJobsDeps extends NewPageGateDeps {
  db: Db
  /** Allow-listed BookStack base URLs (`F451_IMPORT_BOOKSTACK_URLS`); empty → every POST is 400. */
  instances: readonly string[]
  /** Size limit of a file-import upload in MiB (`F451_IMPORT_MAX_UPLOAD_MB`). */
  fileImportMaxUploadMb: number
  /** Temp files of uploads; removed per job and at shutdown. */
  tempFiles: TempFiles
  jobs: JobRegistry
  publicBaseUrl: string
  /** `fetch` against this app's own routes (`injectFetch`). */
  selfFetch: typeof fetch
  /** Tests inject a fake. */
  bookstack: BookStackFactory
  /** Convert service client (`F451_CONVERT_URL`); null → Office import is off. */
  converter: Converter | null
}

interface Credentials {
  instance: string
  tokenId: string
  tokenSecret: string
}

interface ImportBody extends Credentials {
  source: { book?: string; shelf?: string; page?: number }
  parentId?: string
  update: boolean
  release: boolean
  dryRun: boolean
}

interface ExportBody extends Credentials {
  pageId?: string
  bookId?: number
  dryRun: boolean
}

const nonEmpty = { type: 'string', minLength: 1 } as const

const credentialProperties = {
  instance: nonEmpty,
  tokenId: nonEmpty,
  tokenSecret: nonEmpty,
} as const

const catalogSchema = {
  tags: ['import'],
  body: {
    type: 'object',
    properties: credentialProperties,
    required: ['instance', 'tokenId', 'tokenSecret'],
    additionalProperties: false,
  },
} as const

const spaceParams = {
  type: 'object',
  properties: { space: { type: 'string' } },
  required: ['space'],
} as const

const importSchema = {
  tags: ['import'],
  params: spaceParams,
  body: {
    type: 'object',
    properties: {
      ...credentialProperties,
      source: {
        type: 'object',
        properties: {
          book: nonEmpty,
          shelf: nonEmpty,
          page: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
      parentId: nonEmpty,
      update: { type: 'boolean' },
      release: { type: 'boolean' },
      dryRun: { type: 'boolean' },
    },
    required: ['instance', 'tokenId', 'tokenSecret', 'source', 'update', 'release', 'dryRun'],
    additionalProperties: false,
  },
} as const

const exportSchema = {
  tags: ['import'],
  params: spaceParams,
  body: {
    type: 'object',
    properties: {
      ...credentialProperties,
      pageId: nonEmpty,
      bookId: { type: 'integer', minimum: 1 },
      dryRun: { type: 'boolean' },
    },
    required: ['instance', 'tokenId', 'tokenSecret', 'dryRun'],
    additionalProperties: false,
  },
} as const

// No `body` schema: `@fastify/multipart` leaves `request.body` empty in this
// mode (see `uploadMediaSchema` in drafts.ts); the fields are checked by hand.
const fileImportSchema = {
  tags: ['import'],
  params: spaceParams,
  consumes: ['multipart/form-data'],
} as const

/** `POST /api/spaces/:space/import/file` takes the ZIP in this multipart field;
 *  the text fields are `format`, `parentId`, `update`, `release`, `dryRun`. */
const FILE_FIELD = 'file'
const OFFICE_EXTENSION_LIST: readonly string[] = Object.values(OFFICE_EXTENSIONS).flat()

/** Lower-case extension of an upload name without the dot ('' if none). */
function uploadExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1]!.toLowerCase() : ''
}

/** Final path segment of a client-supplied file name. */
function uploadBaseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? ''
}
/** Upper bound on text fields per request (unknown ones are ignored). */
const MAX_FIELDS = 20

/** Multipart flag fields: `'true'` or `'false'`; missing counts as false. */
function parseFlag(value: string | undefined): boolean | null {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  return null
}

const jobParams = {
  tags: ['import'],
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
} as const

/** Records `code(...).send(...)` so a handler can answer after its cleanup. */
function holdReply(): FastifyReply & { statusCode: number; payload: unknown } {
  const held = {
    statusCode: 200,
    payload: undefined as unknown,
    code(status: number) {
      held.statusCode = status
      return held
    },
    send(payload: unknown) {
      held.payload = payload
      return held
    },
  }
  return held as unknown as FastifyReply & { statusCode: number; payload: unknown }
}

function badRequest(reply: FastifyReply, reason: string): FastifyReply {
  return reply.code(400).send({ status: 'bad_request', reason })
}

function unknownInstance(reply: FastifyReply): FastifyReply {
  return badRequest(reply, 'This BookStack instance is not allowed.')
}

function uploadTooLarge(reply: FastifyReply, maxUploadMb: number): FastifyReply {
  return reply
    .code(413)
    .send({ status: 'payload_too_large', reason: `The file exceeds the upload limit of ${maxUploadMb} MB.` })
}

function jobNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ status: 'not_found', reason: 'Job not found.' })
}

function startRefused(reply: FastifyReply, result: Exclude<StartResult, { ok: true }>): FastifyReply {
  if (result.reason === 'busy') {
    return reply
      .code(409)
      .send({ status: 'conflict', reason: 'You already have a running import or export.', jobId: result.id })
  }
  return reply.code(429).send({ status: 'rate_limited', reason: 'Too many imports or exports running, try again later.' })
}

/** BookStack refused the token → 400; anything else (unreachable, 5xx) → 502. */
function bookstackErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BookStackApiError && (err.status === 401 || err.status === 403)) {
    return badRequest(reply, 'BookStack rejected the token')
  }
  const message = err instanceof Error ? err.message : String(err)
  return reply.code(502).send({ status: 'error', reason: `BookStack: ${message}` })
}

/**
 * Import from and export to BookStack, started from the web UI (#128).
 *
 * All routes need a real browser session (`requireBrowserSession`): a PAT must
 * not start jobs, which themselves mint PATs. Jobs run in the background
 * (`JobRegistry`); the UI polls `GET /api/jobs/:id`. A job of another user is
 * a 404, like an unknown or expired one.
 */
export function registerImportJobRoutes(app: FastifyInstance, deps: ImportJobsDeps): void {
  const runDeps: RunDeps = {
    db: deps.db,
    selfFetch: deps.selfFetch,
    bookstack: deps.bookstack,
    publicBaseUrl: deps.publicBaseUrl,
    converter: deps.converter,
  }

  app.register(async (instance) => {
    instance.get(
      '/api/import/instances',
      { schema: { tags: ['import'] }, preHandler: requireBrowserSession },
      async () => ({
        bookstack: deps.instances,
        fileImport: { maxUploadMb: deps.fileImportMaxUploadMb, office: deps.converter !== null },
      }),
    )

    instance.post<{ Body: Credentials }>(
      '/api/import/bookstack/catalog',
      { schema: catalogSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const url = findInstance(deps.instances, req.body.instance)
        if (!url) return unknownInstance(reply)
        const bs = deps.bookstack(url, req.body.tokenId, req.body.tokenSecret)
        try {
          const books = await bs.getAllBooks()
          const shelfList = await bs.getShelves()
          const shelves: Array<{ id: number; name: string; books: number[] }> = []
          for (const s of shelfList.data) {
            const shelf = await bs.getShelf(s.id)
            shelves.push({ id: shelf.id, name: shelf.name, books: (shelf.books ?? []).map((b) => b.id) })
          }
          return {
            shelves,
            books: books.map((b) => ({ id: b.id, name: b.name, slug: b.slug })),
          }
        } catch (err) {
          return bookstackErrorReply(reply, err)
        }
      },
    )

    instance.post<{ Params: { space: string }; Body: ImportBody }>(
      '/api/spaces/:space/import/bookstack',
      { schema: importSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const body = req.body
        const url = findInstance(deps.instances, body.instance)
        if (!url) return unknownInstance(reply)

        const { book, shelf, page } = body.source
        const given = [book, shelf, page].filter((v) => v !== undefined)
        if (given.length !== 1) return badRequest(reply, 'source needs exactly one of book, shelf or page.')
        const source: BookStackSelector =
          book !== undefined ? { book } : shelf !== undefined ? { shelf } : { page: String(page) }

        const userId = req.user!.id
        const gate = await resolveNewPageWriteContext(deps, userId, req.params.space)
        if (!gate.ok) return reply.code(gate.status).send(gate.body)

        const result = deps.jobs.start(
          userId,
          'import-bookstack',
          gate.space.id,
          importRun(runDeps, {
            userId,
            instance: url,
            tokenId: body.tokenId,
            tokenSecret: body.tokenSecret,
            space: gate.space.id,
            source,
            ...(body.parentId ? { parentId: body.parentId } : {}),
            update: body.update,
            release: body.release,
            dryRun: body.dryRun,
          }),
        )
        if (!result.ok) return startRefused(reply, result)
        return reply.code(202).send({ jobId: result.id })
      },
    )

    // File import (#90): a ZIP of a Markdown folder or an Obsidian vault. The
    // upload streams to a temp file; the archive is validated before a job
    // starts, so a rejected archive is a 400 with the reason. The job owns the
    // temp file from then on and removes it when it ends.
    instance.post<{ Params: { space: string } }>(
      '/api/spaces/:space/import/file',
      { schema: fileImportSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const userId = req.user!.id
        // Rights first: nobody without write access gets to store an upload.
        const gate = await resolveNewPageWriteContext(deps, userId, req.params.space)
        if (!gate.ok) return reply.code(gate.status).send(gate.body)
        if (!req.isMultipart()) return badRequest(reply, 'Expected a multipart/form-data upload.')

        const maxMb = deps.fileImportMaxUploadMb
        const maxBytes = Math.floor(maxMb * 1024 * 1024)
        // Answers are held until the temp file is gone: a client that looks
        // right after a refused upload must not find it.
        const held = holdReply()
        await (async () => {
          const tempFile = deps.tempFiles.create()
          let handedOver = false
          let out: WriteStream | undefined
          try {
            // `parts()` rather than `file()`: the text fields may come before
            // or after the file.
            const fields: Record<string, string> = {}
            let gotFile = false
            let uploadName = ''
            try {
              const parts = req.parts({ limits: { fileSize: maxBytes, files: 1, fields: MAX_FIELDS } })
              for await (const part of parts) {
                if (part.type === 'field') {
                  if (typeof part.value === 'string') fields[part.fieldname] = part.value
                  continue
                }
                if (part.fieldname !== FILE_FIELD) {
                  part.file.resume()
                  continue
                }
                uploadName = uploadBaseName(part.filename)
                out = createWriteStream(tempFile)
                await pipeline(part.file, out)
                if (part.file.truncated) return uploadTooLarge(held, maxMb)
                gotFile = true
              }
            } catch (err) {
              if (err instanceof req.server.multipartErrors.RequestFileTooLargeError) return uploadTooLarge(held, maxMb)
              return badRequest(held, 'The upload could not be read.')
            }
            if (!gotFile) return badRequest(held, `Multipart field "${FILE_FIELD}" is missing.`)

            const format = fields.format
            if (format !== 'markdown' && format !== 'obsidian' && format !== 'html' && format !== 'office') {
              return badRequest(held, 'format must be "markdown", "obsidian", "html" or "office".')
            }
            if (format === 'office' && !deps.converter) {
              return badRequest(held, 'Office import is not available: no convert service is configured.')
            }
            const split = fields.split === '1' || fields.split === 'true'
            const update = parseFlag(fields.update)
            const release = parseFlag(fields.release)
            const dryRun = parseFlag(fields.dryRun)
            if (update === null || release === null || dryRun === null) {
              return badRequest(held, 'update, release and dryRun must be "true" or "false".')
            }
            const parentId = fields.parentId ? fields.parentId : undefined
            let text: Partial<WordOptions> = {}
            if (format === 'office') {
              const parsed = parseWordOptions(fields, split)
              if (!parsed.ok) return badRequest(held, parsed.error)
              text = parsed.text
            } else if (hasWordOptions(fields)) {
              return badRequest(held, 'The Word options are only valid for format "office".')
            }

            let source: FileSource
            try {
              const bytes = await readFile(tempFile)
              const ext = uploadExtension(uploadName)
              if (format === 'office' && ext !== 'zip') {
                // A single Office file (itself a ZIP for OOXML/ODF; the loader checks it).
                if (!OFFICE_EXTENSION_LIST.includes(ext)) {
                  return badRequest(held, 'Upload a .zip or an Office file (' + OFFICE_EXTENSION_LIST.join(', ') + ').')
                }
                source = {
                  list: async () => [uploadName],
                  read: async (p) => {
                    if (p !== uploadName) throw new Error(`not in the source: ${p}`)
                    return bytes
                  },
                }
              } else {
                source = zipSource(bytes)
              }
            } catch (err) {
              if (err instanceof ArchiveRejectedError) return badRequest(held, err.message)
              throw err
            }

            const result = deps.jobs.start(
              userId,
              'import-file',
              gate.space.id,
              fileImportRun(runDeps, {
                userId,
                space: gate.space.id,
                format,
                source,
                ...(format === 'office'
                  ? { split, text, lang: gate.space.defaultLang === 'de' ? ('de' as const) : ('en' as const) }
                  : {}),
                cleanup: () => deps.tempFiles.remove(tempFile),
                ...(parentId ? { parentId } : {}),
                update,
                release,
                dryRun,
              }),
            )
            if (!result.ok) return startRefused(held, result)
            handedOver = true
            return held.code(202).send({ jobId: result.id })
          } finally {
            if (!handedOver) {
              // The stream opens its file asynchronously: when the upload is cut
              // short, wait for it to close, or the file would reappear after
              // the removal.
              if (out && !out.closed) await new Promise<void>((resolve) => out!.once('close', () => resolve()))
              await deps.tempFiles.remove(tempFile)
            }
          }
        })()
        return reply.code(held.statusCode).send(held.payload)
      },
    )

    instance.post<{ Params: { space: string }; Body: ExportBody }>(
      '/api/spaces/:space/export/bookstack',
      { schema: exportSchema, preHandler: requireBrowserSession },
      async (req, reply) => {
        const body = req.body
        const url = findInstance(deps.instances, body.instance)
        if (!url) return unknownInstance(reply)

        const userId = req.user!.id
        const space = deps.spaces.find((s) => s.id === req.params.space)
        if (!space || !(await deps.access.canRead(userId, space))) {
          return reply.code(404).send({ status: 'not_found', reason: `Space "${req.params.space}" is not configured.` })
        }

        const result = deps.jobs.start(
          userId,
          'export-bookstack',
          space.id,
          exportRun(runDeps, {
            userId,
            instance: url,
            tokenId: body.tokenId,
            tokenSecret: body.tokenSecret,
            space: space.id,
            ...(body.pageId ? { pageId: body.pageId } : {}),
            ...(body.bookId !== undefined ? { bookId: body.bookId } : {}),
            dryRun: body.dryRun,
          }),
        )
        if (!result.ok) return startRefused(reply, result)
        return reply.code(202).send({ jobId: result.id })
      },
    )

    instance.get<{ Params: { id: string } }>(
      '/api/jobs/:id',
      { schema: jobParams, preHandler: requireBrowserSession },
      async (req, reply) => {
        const job = deps.jobs.get(req.user!.id, req.params.id)
        return job ?? jobNotFound(reply)
      },
    )

    instance.post<{ Params: { id: string } }>(
      '/api/jobs/:id/cancel',
      { schema: jobParams, preHandler: requireBrowserSession },
      async (req, reply) => {
        const job = deps.jobs.cancel(req.user!.id, req.params.id)
        return job ?? jobNotFound(reply)
      },
    )
  })
}
