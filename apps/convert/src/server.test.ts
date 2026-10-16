import { afterEach, describe, expect, it, vi } from 'vitest'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConvertError } from '@f451/import/office/soffice'
import { createConvertServer, type ConvertServerOptions, type Runner } from './server.js'

const servers: Server[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise<void>((r) => s.close(() => r()))
  }
})

async function start(opts: ConvertServerOptions = {}) {
  const lines: string[] = []
  const { server, jobs } = createConvertServer({ workRoot: '/work-test', log: (l) => lines.push(l), ...opts })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, jobs, lines }
}

const post = (url: string, body: Uint8Array | string = 'file') =>
  fetch(url, { method: 'POST', body: typeof body === 'string' ? body : new Blob([body as Uint8Array<ArrayBuffer>]) })

const okRunner: Runner = async (_input, to) => (to === 'html' ? { zip: new Uint8Array([80, 75]) } : { file: new Uint8Array([1, 2]) })

describe('convert service', () => {
  it('answers /health', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('answers 404 for other paths', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('converts to html and returns the ZIP', async () => {
    const runner = vi.fn(okRunner)
    const { base, lines } = await start({ runner, timeoutS: 42 })
    const res = await post(`${base}/convert?to=html&name=${encodeURIComponent('Bericht ü.docx')}`, 'docx-bytes')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([80, 75]))
    const [input, to, opts] = runner.mock.calls[0]
    expect(input.name).toBe('Bericht ü.docx')
    expect(Buffer.from(input.bytes).toString()).toBe('docx-bytes')
    expect(to).toBe('html')
    expect(opts).toEqual({ timeoutS: 42, workRoot: '/work-test' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^convert to=html size=10 ms=\d+ status=200$/)
    expect(lines[0]).not.toContain('Bericht')
  })

  it('returns the exported file with its type', async () => {
    const { base } = await start({ runner: okRunner })
    const res = await post(`${base}/convert?to=pdf`, 'zip')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it.each([
    ['unknown target', '/convert?to=exe&name=a.docx'],
    ['missing name', '/convert?to=html'],
    ['unknown extension', '/convert?to=html&name=a.txt'],
    ['invalid timeout', '/convert?to=pdf&timeout=abc'],
  ])('answers 400 for %s', async (_label, path) => {
    const runner = vi.fn(okRunner)
    const { base } = await start({ runner })
    const res = await post(`${base}${path}`)
    expect(res.status).toBe(400)
    expect(runner).not.toHaveBeenCalled()
  })

  it('answers 400 for an empty body', async () => {
    const { base } = await start({ runner: okRunner })
    expect((await post(`${base}/convert?to=pdf`, '')).status).toBe(400)
  })

  it('answers 405 for GET /convert', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/convert?to=pdf`)).status).toBe(405)
  })

  it('answers 413 for a declared body over the limit', async () => {
    const runner = vi.fn(okRunner)
    const { base } = await start({ runner, maxBytes: 10 })
    const res = await post(`${base}/convert?to=pdf`, 'x'.repeat(20))
    expect(res.status).toBe(413)
    expect(runner).not.toHaveBeenCalled()
  })

  it('answers 413 for a streamed body over the limit', async () => {
    const runner = vi.fn(okRunner)
    const { base } = await start({ runner, maxBytes: 10 })
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/convert?to=pdf`, { method: 'POST' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      // No content-length: chunked transfer.
      req.write('x'.repeat(8))
      req.write('x'.repeat(8))
      req.end()
    })
    expect(status).toBe(413)
    expect(runner).not.toHaveBeenCalled()
  })

  it.each([422, 504])('passes a runner failure on as %i', async (status) => {
    const runner: Runner = async () => {
      throw new ConvertError(`failed with ${status}`, status)
    }
    const { base } = await start({ runner })
    const res = await post(`${base}/convert?to=html&name=a.docx`)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: `failed with ${status}` })
  })

  it('answers 500 for an unexpected error', async () => {
    const runner: Runner = async () => {
      throw new Error('boom')
    }
    const { base } = await start({ runner })
    expect((await post(`${base}/convert?to=pdf`)).status).toBe(500)
  })

  it('caps the requested timeout', async () => {
    const runner = vi.fn(okRunner)
    const { base } = await start({ runner, maxTimeoutS: 600 })
    await post(`${base}/convert?to=pdf&timeout=9999`)
    await post(`${base}/convert?to=pdf&timeout=5`)
    expect(runner.mock.calls.map((c) => c[2].timeoutS)).toEqual([600, 5])
  })

  it('runs one conversion at a time', async () => {
    let active = 0
    let maxActive = 0
    const runner: Runner = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      return { file: new Uint8Array([1]) }
    }
    const { base } = await start({ runner })
    const results = await Promise.all([1, 2, 3].map(() => post(`${base}/convert?to=pdf`)))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(maxActive).toBe(1)
  })

  it('answers 503 when the queue is full', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let markStarted!: () => void
    const started = new Promise<void>((r) => (markStarted = r))
    const runner: Runner = async () => {
      markStarted()
      await gate
      return { file: new Uint8Array([1]) }
    }
    const { base, jobs } = await start({ runner, queueMax: 1 })

    const first = post(`${base}/convert?to=pdf`)
    await started
    const second = post(`${base}/convert?to=pdf`)
    await vi.waitFor(() => expect(jobs()).toBe(2))

    const third = await post(`${base}/convert?to=pdf`)
    expect(third.status).toBe(503)

    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
  })
})
