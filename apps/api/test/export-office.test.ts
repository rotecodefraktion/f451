import { randomUUID } from 'node:crypto'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import type { Converter } from '@f451/import'
import { buildApp, type AppOptions } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { apiTokens, users } from '../src/db/schema.js'
import { contentDisposition } from '../src/export/office.js'
import { JobRegistry, type JobView } from '../src/import/jobs.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 23).toString('base64')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Entries of a ZIP (stored or deflated). Written by hand because `fflate`
 *  is a dependency of `@f451/import`, not of the API. */
function unzip(buf: Buffer): Record<string, Buffer> {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: Record<string, Buffer> = {}
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    out[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

interface Call {
  files: Record<string, Buffer>
  to: string
  timeoutS: number | undefined
}

/** A `Converter` that records each bundle and answers with fixed bytes. */
function recordingConverter(): { converter: Converter; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    converter: {
      toHtml: async () => {
        throw new Error('not used by the export')
      },
      fromBundle: async (zip, to, opts) => {
        calls.push({ files: unzip(Buffer.from(zip)), to, timeoutS: opts?.timeoutS })
        return new Uint8Array(Buffer.from(`FILE-${to}`))
      },
    },
  }
}

const page = (id: string, title: string, body: string) => `---\nid: ${id}\ntitle: ${title}\nlang: en\n---\n# ${title}\n\n${body}\n`

describe('JobRegistry result files', () => {
  async function tempFile(): Promise<string> {
    const path = join(tmpdir(), `f451-export-test-${randomUUID()}.docx`)
    await writeFile(path, 'x')
    return path
  }

  async function gone(path: string): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (!(await stat(path).then(() => true, () => false))) return true
      await sleep(10)
    }
    return false
  }

  async function settle(reg: JobRegistry, userId: string, id: string): Promise<JobView> {
    for (let i = 0; i < 200; i++) {
      const job = reg.get(userId, id)
      if (job && job.status !== 'running') return job
      await sleep(5)
    }
    throw new Error('job did not settle')
  }

  it('serves the file to its owner only and removes it after the keep time', async () => {
    const reg = new JobRegistry({ fileKeepMs: 50 })
    const path = await tempFile()
    const started = reg.start('u1', 'export-file', 's', async () => ({
      report: '',
      counts: {},
      file: { path, name: 'a.docx', contentType: 'application/x-test' },
    }))
    if (!started.ok) throw new Error('not started')
    await settle(reg, 'u1', started.id)

    expect(reg.file('u1', started.id)).toEqual({ path, name: 'a.docx', contentType: 'application/x-test' })
    expect(reg.file('u2', started.id)).toBeNull()

    await sleep(100)
    expect(reg.file('u1', started.id)).toBeNull()
    expect(await gone(path)).toBe(true)
  })

  it('a cancelled job keeps no file', async () => {
    const reg = new JobRegistry()
    const path = await tempFile()
    const started = reg.start('u1', 'export-file', 's', async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { report: '', counts: {}, file: { path, name: 'a.docx', contentType: 'x' } }
    })
    if (!started.ok) throw new Error('not started')
    reg.cancel('u1', started.id)
    expect((await settle(reg, 'u1', started.id)).status).toBe('cancelled')
    expect(reg.file('u1', started.id)).toBeNull()
    expect(await gone(path)).toBe(true)
  })

  it('shutdown removes the result files', async () => {
    const reg = new JobRegistry()
    const path = await tempFile()
    const started = reg.start('u1', 'export-file', 's', async () => ({
      report: '',
      counts: {},
      file: { path, name: 'a.docx', contentType: 'x' },
    }))
    if (!started.ok) throw new Error('not started')
    await settle(reg, 'u1', started.id)
    await reg.shutdown()
    expect(reg.file('u1', started.id)).toBeNull()
    expect(await gone(path)).toBe(true)
  })
})

describe('contentDisposition', () => {
  it('has an ASCII filename and the exact name as filename*', () => {
    expect(contentDisposition('Grüße & Co.docx')).toBe(
      `attachment; filename="Gru-e-Co.docx"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%26%20Co.docx`,
    )
    expect(contentDisposition("it's (x).pdf")).toBe(`attachment; filename="it-s-x.pdf"; filename*=UTF-8''it%27s%20%28x%29.pdf`)
    expect(contentDisposition('ßß.xlsx')).toBe(`attachment; filename="export.xlsx"; filename*=UTF-8''%C3%9F%C3%9F.xlsx`)
  })
})

describe.sequential('Office export routes', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let space: SpaceConfig
  let privateSpace: SpaceConfig
  let bigSpace: SpaceConfig
  let app: FastifyInstance
  let appOff: FastifyInstance
  let recording: ReturnType<typeof recordingConverter>

  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'eo-writer'
  const readerUserId = 'eo-reader'
  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    const repo: RepoRef = await forgejo.createRepo('export-office', { private: false })
    await provider.commitFiles(
      repo,
      [
        { op: 'write', path: 'index.md', content: Buffer.from(page('eo-home', 'Home', 'Home body.')) },
        {
          op: 'write',
          path: 'guide/index.md',
          content: Buffer.from(page('eo-guide', 'Guide Ä', 'Guide body text.\n\n| Item | Count |\n|---|---|\n| Apples | 3 |')),
        },
        { op: 'write', path: 'guide/child/index.md', content: Buffer.from(page('eo-child', 'Child', 'Child body text.')) },
      ],
      { branch: 'main', message: 'seed' },
    )
    const repoPrivate = await forgejo.createRepo('export-office-private', { private: true })
    await provider.writeFile(repoPrivate, 'index.md', page('eo-secret', 'Secret', 'Secret body.'), {
      branch: 'main',
      message: 'seed',
    })
    const repoBig = await forgejo.createRepo('export-office-big', { private: false })
    await provider.commitFiles(
      repoBig,
      [
        { op: 'write' as const, path: 'index.md', content: Buffer.from(page('eo-big', 'Big', 'Root.')) },
        ...Array.from({ length: 200 }, (_, i) => ({
          op: 'write' as const,
          path: `p${i}/index.md`,
          content: Buffer.from(page(`eo-big-${i}`, `Page ${i}`, 'Text.')),
        })),
      ],
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'export-office-space', name: 'Export Office', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'en', repoRef: repo,
    }
    privateSpace = {
      id: 'export-office-private', name: 'Export Office Private', provider: 'forgejo',
      owner: repoPrivate.owner, repo: repoPrivate.repo, defaultLang: 'en', repoRef: repoPrivate,
    }
    bigSpace = {
      id: 'export-office-big', name: 'Export Office Big', provider: 'forgejo',
      owner: repoBig.owner, repo: repoBig.repo, defaultLang: 'en', repoRef: repoBig,
    }
    await indexSpace({ db, provider }, space)
    await indexSpace({ db, provider }, privateSpace)
    await indexSpace({ db, provider }, bigSpace)

    writer = await forgejo.createUser('eo-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    await forgejo.addCollaborator(bigSpace.repoRef, writer.username, 'read')
    reader = await forgejo.createUser('eo-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'eo-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'eo-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    recording = recordingConverter()
    const base: AppOptions = {
      databaseUrl: pg.connectionString,
      spaces: [space, privateSpace, bigSpace],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      publicBaseUrl: 'https://wiki.example.org',
      // The 201-page job reads every page through the API with a job token,
      // which counts against the user's token budget.
      rateLimits: {
        auth: { max: 1000, windowMs: 60_000 },
        search: { max: 1000, windowMs: 60_000 },
        apiToken: { max: 100_000, windowMs: 60_000 },
      },
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    }
    app = buildApp({ ...base, importConverter: recording.converter })
    appOff = buildApp(base)
    await Promise.all([app.ready(), appOff.ready()])

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await appOff?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  function instant(target: FastifyInstance, session: string, pageId: string, query: string) {
    return target.inject({ method: 'GET', url: `/api/pages/${pageId}/export?${query}`, cookies: cookiesOf(session) })
  }

  function startJob(session: string, spaceId: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/export/file`,
      cookies: cookiesOf(session),
      payload: body,
    })
  }

  async function waitForJob(session: string, id: string): Promise<JobView> {
    for (let i = 0; i < 300; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, cookies: cookiesOf(session) })
      expect(res.statusCode).toBe(200)
      const job = res.json() as JobView
      if (job.status !== 'running') return job
      await sleep(100)
    }
    throw new Error(`job ${id} did not finish`)
  }

  function lastCall(): Call {
    const call = recording.calls.at(-1)
    if (!call) throw new Error('the converter was not called')
    return call
  }

  it('without a convert service → 400 on the instant route and the job route', async () => {
    const res = await instant(appOff, writerSession, 'eo-guide', 'format=docx')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ reason: 'export not configured' })

    const job = await appOff.inject({
      method: 'POST',
      url: `/api/spaces/${space.id}/export/file`,
      cookies: cookiesOf(writerSession),
      payload: { pageId: 'eo-guide', format: 'docx', subpages: false },
    })
    expect(job.statusCode).toBe(400)
  })

  it.each([
    ['docx', 'document.html', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['pdf', 'document.html', 'application/pdf'],
    ['pptx', 'document.fodp', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['xlsx', 'document.fods', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('instant %s with subpages: the bundle holds both pages, the file comes back', async (format, entry, type) => {
    const res = await instant(app, writerSession, 'eo-guide', `format=${format}&subpages=1`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe(type)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Guide-A.${format}"; filename*=UTF-8''Guide%20%C3%84.${format}`,
    )
    expect(res.body).toBe(`FILE-${format}`)

    const call = lastCall()
    expect(call.to).toBe(format)
    expect(call.timeoutS).toBeUndefined()
    expect(Object.keys(call.files)).toContain(entry)
    const doc = call.files[entry]!.toString('utf8')
    if (format === 'xlsx') {
      expect(doc).toContain('Apples')
    } else {
      expect(doc).toContain('Guide body text.')
      expect(doc).toContain('Child body text.')
    }
  })

  it('without subpages only the start page is exported', async () => {
    const res = await instant(app, writerSession, 'eo-guide', 'format=docx&subpages=0')
    expect(res.statusCode).toBe(200)
    const html = lastCall().files['document.html']!.toString('utf8')
    expect(html).toContain('Guide body text.')
    expect(html).not.toContain('Child body text.')
  })

  it('a session caller gets a read token that is revoked afterwards', async () => {
    const rows = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, writerUserId), like(apiTokens.label, 'import job export-%')))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.scope).toBe('read')
      expect(r.revokedAt).not.toBeNull()
    }
  })

  it('an API token caller (CLI, MCP) may use the instant route', async () => {
    const minted = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies: cookiesOf(writerSession),
      payload: { label: 'export probe', scope: 'read' },
    })
    expect(minted.statusCode).toBe(200)
    const { token } = minted.json() as { token: string }
    const exportTokens = () =>
      db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, writerUserId), like(apiTokens.label, 'import job export-%')))
    const before = await exportTokens()

    const res = await app.inject({
      method: 'GET',
      url: '/api/pages/eo-guide/export?format=pdf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('FILE-pdf')

    // The caller's own token was used; no further token was minted.
    expect(await exportTokens()).toHaveLength(before.length)
  })

  it('read access is enough; no access, an unknown page or a bad format → 404/400', async () => {
    expect((await instant(app, readerSession, 'eo-guide', 'format=docx')).statusCode).toBe(200)
    expect((await instant(app, writerSession, 'eo-secret', 'format=docx')).statusCode).toBe(404)
    expect((await instant(app, writerSession, 'does-not-exist', 'format=docx')).statusCode).toBe(404)
    expect((await instant(app, writerSession, 'eo-guide', 'format=odt')).statusCode).toBe(400)
  })

  it('more than 200 pages → 413 pointing to the panel export', async () => {
    const calls = recording.calls.length
    const res = await instant(app, writerSession, 'eo-big', 'format=docx&subpages=1')
    expect(res.statusCode).toBe(413)
    expect((res.json() as { reason: string }).reason).toContain('panel')
    expect(recording.calls.length).toBe(calls)
  })

  it('xlsx of a page without tables → 422', async () => {
    const res = await instant(app, writerSession, 'eo-child', 'format=xlsx')
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ reason: 'no tables to export' })
  })

  it('draft content is not exported', async () => {
    const opened = await app.inject({ method: 'POST', url: '/api/pages/eo-child/draft', cookies: cookiesOf(writerSession) })
    expect(opened.statusCode).toBe(200)
    const { baseSha, content } = opened.json() as { baseSha: string; content: string }
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/pages/eo-child/draft',
      cookies: cookiesOf(writerSession),
      payload: { content: `${content}\nDRAFT-ONLY-MARKER\n`, baseSha, message: 'draft' },
    })
    expect(saved.statusCode).toBe(200)

    const res = await instant(app, writerSession, 'eo-guide', 'format=docx&subpages=1')
    expect(res.statusCode).toBe(200)
    const html = lastCall().files['document.html']!.toString('utf8')
    expect(html).toContain('Child body text.')
    expect(html).not.toContain('DRAFT-ONLY-MARKER')
  })

  describe('background job', () => {
    async function exportTempFiles(): Promise<string[]> {
      return (await readdir(tmpdir())).filter((n) => n.startsWith('f451-export-') && !n.startsWith('f451-export-test-'))
    }

    it('runs to done; the owner downloads the file, another user gets 404', async () => {
      const before = await exportTempFiles()
      const res = await startJob(writerSession, space.id, { pageId: 'eo-guide', format: 'pptx', subpages: true })
      expect(res.statusCode).toBe(202)
      const { jobId } = res.json() as { jobId: string }

      const job = await waitForJob(writerSession, jobId)
      expect(job.status).toBe('done')
      expect(job.kind).toBe('export-file')
      expect(job.counts.pages).toBe(2)
      expect(job.report).toContain('# Export report')
      expect(lastCall().timeoutS).toBe(600)
      expect((await exportTempFiles()).filter((n) => !before.includes(n))).toHaveLength(1)

      const file = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/file`, cookies: cookiesOf(writerSession) })
      expect(file.statusCode).toBe(200)
      expect(file.body).toBe('FILE-pptx')
      expect(file.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      )
      expect(file.headers['content-disposition']).toContain(`filename*=UTF-8''Guide%20%C3%84.pptx`)

      const foreign = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/file`, cookies: cookiesOf(readerSession) })
      expect(foreign.statusCode).toBe(404)
    }, 60_000)

    it('a job without the page limit exports more than 200 pages', async () => {
      const res = await startJob(writerSession, bigSpace.id, { pageId: 'eo-big', format: 'docx', subpages: true })
      expect(res.statusCode).toBe(202)
      const job = await waitForJob(writerSession, (res.json() as { jobId: string }).jobId)
      expect(job.status).toBe('done')
      expect(job.counts.pages).toBe(201)
    }, 120_000)

    it('a failed job has no file', async () => {
      const res = await startJob(writerSession, space.id, { pageId: 'eo-child', format: 'xlsx', subpages: false })
      expect(res.statusCode).toBe(202)
      const { jobId } = res.json() as { jobId: string }
      const job = await waitForJob(writerSession, jobId)
      expect(job.status).toBe('failed')
      const file = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/file`, cookies: cookiesOf(writerSession) })
      expect(file.statusCode).toBe(404)
    })

    it('no access, a page of another space or a Bearer caller → 404/404/403', async () => {
      expect((await startJob(writerSession, privateSpace.id, { pageId: 'eo-secret', format: 'docx', subpages: false })).statusCode).toBe(404)
      expect((await startJob(writerSession, bigSpace.id, { pageId: 'eo-guide', format: 'docx', subpages: false })).statusCode).toBe(404)

      const minted = await app.inject({
        method: 'POST',
        url: '/api/tokens',
        cookies: cookiesOf(writerSession),
        payload: { label: 'job probe', scope: 'write' },
      })
      const { token } = minted.json() as { token: string }
      const res = await app.inject({
        method: 'POST',
        url: `/api/spaces/${space.id}/export/file`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pageId: 'eo-guide', format: 'docx', subpages: false },
      })
      expect(res.statusCode).toBe(403)
    })

    it('unknown job → 404 on the file route', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs/nope/file', cookies: cookiesOf(writerSession) })
      expect(res.statusCode).toBe(404)
    })
  })
})
