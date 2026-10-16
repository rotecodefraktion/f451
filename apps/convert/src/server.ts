// Convert service: a small HTTP wrapper around `soffice --headless`
// (spec 2026-10-16-office-import §1). One conversion at a time, a bounded
// queue, body and timeout limits. No framework on purpose.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { ConvertError, isConvertTarget, officeKind, runSoffice, type ConvertTarget } from '@f451/import/office/soffice'

export type Runner = typeof runSoffice

export interface ConvertServerOptions {
  /** Replaced in tests. */
  runner?: Runner
  workRoot?: string
  /** Waiting requests beyond the running one; more → 503. */
  queueMax?: number
  maxBytes?: number
  timeoutS?: number
  maxTimeoutS?: number
  log?: (line: string) => void
}

const FILE_TYPES: Record<Exclude<ConvertTarget, 'html'>, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function createConvertServer(opts: ConvertServerOptions = {}): { server: Server; jobs: () => number } {
  const runner = opts.runner ?? runSoffice
  const workRoot = opts.workRoot ?? tmpdir()
  const queueMax = opts.queueMax ?? 20
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024
  const timeoutS = opts.timeoutS ?? 60
  const maxTimeoutS = opts.maxTimeoutS ?? 600
  const log = opts.log ?? ((line: string) => console.log(line))

  // Accepted jobs, running and waiting.
  let jobs = 0
  let tail: Promise<unknown> = Promise.resolve()
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = tail.then(fn, fn)
    tail = p.catch(() => undefined)
    return p
  }

  async function convert(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const started = Date.now()
    const toParam = url.searchParams.get('to') ?? ''
    let size = 0
    const finish = (status: number, body: Uint8Array | object, type = 'application/json') => {
      send(req, res, status, body, type)
      // One line per job; never the file name.
      log(`convert to=${isConvertTarget(toParam) ? toParam : '?'} size=${size} ms=${Date.now() - started} status=${status}`)
    }

    if (!isConvertTarget(toParam)) return finish(400, { error: 'unknown target' })
    const to = toParam
    const name = url.searchParams.get('name') ?? ''
    if (to === 'html' && !name) return finish(400, { error: 'name is required for to=html' })
    if (to === 'html' && !officeKind(name)) return finish(400, { error: 'unsupported file type' })

    let jobTimeout = timeoutS
    const t = url.searchParams.get('timeout')
    if (t !== null) {
      if (!/^\d+$/.test(t) || Number(t) <= 0) return finish(400, { error: 'invalid timeout' })
      jobTimeout = Math.min(Number(t), maxTimeoutS)
    }

    const declared = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) return finish(413, { error: 'body too large' })
    if (jobs > queueMax) return finish(503, { error: 'queue full' })

    jobs++
    try {
      // The body is read only when the job's turn comes, so at most one body is
      // held in memory; waiting clients are held back by TCP flow control.
      const result = await enqueue(async () => {
        const bytes = await readBody(req, maxBytes)
        size = bytes.length
        if (size === 0) throw new ConvertError('empty body', 400)
        return runner({ bytes, name: to === 'html' ? name : 'bundle.zip' }, to, { timeoutS: jobTimeout, workRoot })
      })
      if ('zip' in result) finish(200, result.zip, 'application/zip')
      else finish(200, result.file, FILE_TYPES[to as Exclude<ConvertTarget, 'html'>] ?? 'application/octet-stream')
    } catch (e) {
      if (e instanceof ConvertError) finish(e.status, { error: e.message })
      else finish(500, { error: 'internal error' })
    } finally {
      jobs--
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://convert.local')
    if (url.pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method not allowed' })
      return send(req, res, 200, { ok: true })
    }
    if (url.pathname !== '/convert') return send(req, res, 404, { error: 'not found' })
    if (req.method !== 'POST') return send(req, res, 405, { error: 'method not allowed' })
    void convert(req, res, url)
  })
  // Queued requests may wait longer than Node's default request timeout.
  server.requestTimeout = 0
  return { server, jobs: () => jobs }
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: Uint8Array | object, type = 'application/json'): void {
  if (res.headersSent || res.destroyed) return
  const payload = body instanceof Uint8Array ? body : Buffer.from(JSON.stringify(body))
  const headers: Record<string, string | number> = { 'content-type': type, 'content-length': payload.length }
  // An unread body is not drained: close the connection after the answer.
  if (!req.complete) {
    headers.connection = 'close'
    res.on('finish', () => req.destroy())
  }
  res.writeHead(status, headers)
  res.end(payload)
}

function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // The client may have given up while the request waited in the queue.
    if (req.destroyed) return reject(new Error('client closed the connection'))
    const chunks: Buffer[] = []
    let n = 0
    let done = false
    const fail = (e: Error) => {
      if (done) return
      done = true
      reject(e)
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      n += chunk.length
      if (n > max) {
        req.pause()
        fail(new ConvertError('body too large', 413))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(new Uint8Array(Buffer.concat(chunks)))
    })
    req.on('error', fail)
    req.on('close', () => fail(new Error('client closed the connection')))
  })
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { server } = createConvertServer({
    workRoot: process.env.CONVERT_WORK_DIR || tmpdir(),
    queueMax: envNumber('CONVERT_QUEUE', 20),
    maxBytes: envNumber('CONVERT_MAX_MB', 200) * 1024 * 1024,
    timeoutS: envNumber('CONVERT_TIMEOUT_S', 60),
    maxTimeoutS: envNumber('CONVERT_MAX_TIMEOUT_S', 600),
  })
  const port = envNumber('PORT', 8080)
  server.listen(port, '0.0.0.0', () => console.log(`convert listening on :${port}`))
}
