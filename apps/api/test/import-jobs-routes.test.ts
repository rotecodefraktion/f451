import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { crc32 } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { BookStackClient } from '@f451/import'
import { buildApp, type AppOptions } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { apiTokens, users } from '../src/db/schema.js'
import type { JobView } from '../src/import/jobs.js'
import type { BookStackFactory } from '../src/import/run.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 17).toString('base64')
const INSTANCE = 'https://bookstack.example.org'
const TOKEN_ID = 'bs-token-id'
const TOKEN_SECRET = 'bs-very-secret-value'
const WRONG_SECRET = 'bs-wrong-secret'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function bookContents(id: number, pages: Array<{ id: number; name: string; slug: string }>): unknown {
  return {
    id,
    name: `Book ${id}`,
    slug: `book-${id}`,
    description_html: '',
    tags: [],
    contents: pages.map((p, i) => ({ type: 'page', id: p.id, name: p.name, slug: p.slug, priority: i, draft: false })),
  }
}

/** A real `BookStackClient` over a fake `fetch` with canned answers. Book 2
 *  blocks until `releaseBook2()` so a job can be held in `running`. */
function fakeBookStack(): { factory: BookStackFactory; releaseBook2: () => void } {
  let release!: () => void
  const book2Gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pages: Record<number, { id: number; name: string; slug: string }> = {
    11: { id: 11, name: 'Page one', slug: 'page-one' },
    12: { id: 12, name: 'Page two', slug: 'page-two' },
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (auth !== `Token ${TOKEN_ID}:${TOKEN_SECRET}`) return json({ error: { message: 'bad token' } }, 401)
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(href).pathname.replace(/^\/api\//, '')
    if (path === 'books') return json({ data: [{ id: 1, name: 'Book 1', slug: 'book-1' }], total: 1 })
    if (path === 'shelves') return json({ data: [{ id: 5, name: 'Shelf', slug: 'shelf' }], total: 1 })
    if (path === 'shelves/5') return json({ id: 5, name: 'Shelf', slug: 'shelf', books: [{ id: 1, name: 'Book 1', slug: 'book-1' }] })
    if (path === 'books/1') return json(bookContents(1, [pages[11]!, pages[12]!]))
    if (path === 'books/2') {
      await book2Gate
      return json(bookContents(2, []))
    }
    // Pages without attachments or images.
    if (path === 'attachments' || path === 'image-gallery') return json({ data: [], total: 0 })
    const page = /^pages\/(\d+)$/.exec(path)
    if (page && pages[Number(page[1])]) {
      const p = pages[Number(page[1])]!
      return json({ ...p, book_id: 1, priority: 0, html: `<p>${p.name} body</p>`, tags: [] })
    }
    return json({ error: { message: 'not found' } }, 404)
  }) as typeof fetch
  return {
    factory: (url, tokenId, tokenSecret) => new BookStackClient(url, tokenId, tokenSecret, fetchImpl),
    releaseBook2: release,
  }
}

/** A minimal ZIP with STORED entries. Written by hand because `fflate` is a
 *  dependency of `@f451/import`, not of the API; names are taken as given, so
 *  a test can build a zip-slip archive. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const count = Object.keys(files).length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** A real `multipart/form-data` body. `file` goes first on purpose: the route
 *  must also see text fields that follow the file. */
async function uploadBody(
  zip: Buffer,
  fields: Record<string, string>,
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData()
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'vault.zip')
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const req = new Request('http://upload.local/', { method: 'POST', body: form })
  return { payload: Buffer.from(await req.arrayBuffer()), headers: { 'content-type': req.headers.get('content-type')! } }
}

async function importTempFiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith('f451-import-'))
}

describe.sequential('import/export job routes (#128)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let space: SpaceConfig
  let privateSpace: SpaceConfig
  let app: FastifyInstance
  let appOff: FastifyInstance
  let bookstack: ReturnType<typeof fakeBookStack>

  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'ij-writer'
  const readerUserId = 'ij-reader'
  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    const repo: RepoRef = await forgejo.createRepo('import-jobs', { private: false })
    await provider.writeFile(repo, 'index.md', '---\nid: home\ntitle: Home\nlang: en\n---\n# Home\n', {
      branch: 'main',
      message: 'seed',
    })
    const repoPrivate = await forgejo.createRepo('import-jobs-private', { private: true })
    await provider.writeFile(repoPrivate, 'index.md', '---\nid: secret-home\ntitle: Secret\nlang: en\n---\n# Secret\n', {
      branch: 'main',
      message: 'seed',
    })

    space = {
      id: 'import-jobs-space', name: 'Import Jobs', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'en', repoRef: repo,
    }
    privateSpace = {
      id: 'import-jobs-private', name: 'Import Jobs Private', provider: 'forgejo',
      owner: repoPrivate.owner, repo: repoPrivate.repo, defaultLang: 'en', repoRef: repoPrivate,
    }
    await indexSpace({ db, provider }, space)
    await indexSpace({ db, provider }, privateSpace)

    writer = await forgejo.createUser('ij-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('ij-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'ij-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'ij-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    bookstack = fakeBookStack()
    const base: AppOptions = {
      databaseUrl: pg.connectionString,
      spaces: [space, privateSpace],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    }
    app = buildApp({ ...base, importBookstackUrls: [INSTANCE], importBookstack: bookstack.factory })
    // Also serves the 413 test of the file import with a 1 MiB limit.
    appOff = buildApp({ ...base, importBookstack: bookstack.factory, importMaxUploadMb: 1 })
    await Promise.all([app.ready(), appOff.ready()])

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  afterAll(async () => {
    bookstack?.releaseBook2()
    await app?.close()
    await appOff?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })
  const credentials = { instance: INSTANCE, tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }

  function startImport(target: FastifyInstance, session: string, spaceId: string, body: Record<string, unknown> = {}) {
    return target.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/import/bookstack`,
      cookies: cookiesOf(session),
      payload: { ...credentials, source: { book: '1' }, update: false, release: false, dryRun: true, ...body },
    })
  }

  async function waitForJob(session: string, id: string): Promise<JobView> {
    for (let i = 0; i < 300; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, cookies: cookiesOf(session) })
      expect(res.statusCode).toBe(200)
      const job = res.json() as JobView
      if (job.status !== 'running') return job
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`job ${id} did not finish`)
  }

  describe('feature off (no instances configured)', () => {
    it('lists no instances', async () => {
      const res = await appOff.inject({ method: 'GET', url: '/api/import/instances', cookies: cookiesOf(writerSession) })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ bookstack: [], fileImport: { maxUploadMb: 1 } })
    })

    it('answers 400 on all three POST routes for any instance', async () => {
      const catalog = await appOff.inject({
        method: 'POST',
        url: '/api/import/bookstack/catalog',
        cookies: cookiesOf(writerSession),
        payload: credentials,
      })
      expect(catalog.statusCode).toBe(400)

      const imp = await startImport(appOff, writerSession, space.id)
      expect(imp.statusCode).toBe(400)

      const exp = await appOff.inject({
        method: 'POST',
        url: `/api/spaces/${space.id}/export/bookstack`,
        cookies: cookiesOf(writerSession),
        payload: { ...credentials, dryRun: true },
      })
      expect(exp.statusCode).toBe(400)
    })
  })

  it('lists the configured instances', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/import/instances', cookies: cookiesOf(writerSession) })
    expect(res.json()).toEqual({ bookstack: [INSTANCE], fileImport: { maxUploadMb: 200 } })
  })

  it('catalog: unknown instance → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/bookstack/catalog',
      cookies: cookiesOf(writerSession),
      payload: { ...credentials, instance: 'https://other.example.org' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('catalog: lists shelves and books; a rejected token is 400', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/import/bookstack/catalog',
      cookies: cookiesOf(writerSession),
      // Spelled differently from the allow-list: accepted after normalisation.
      payload: { ...credentials, instance: 'https://BookStack.example.org/' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({
      shelves: [{ id: 5, name: 'Shelf', books: [1] }],
      books: [{ id: 1, name: 'Book 1', slug: 'book-1' }],
    })

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/import/bookstack/catalog',
      cookies: cookiesOf(writerSession),
      payload: { ...credentials, tokenSecret: WRONG_SECRET },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ reason: 'BookStack rejected the token' })
  })

  it('a Bearer caller is 403', async () => {
    const minted = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies: cookiesOf(writerSession),
      payload: { label: 'bearer probe', scope: 'write' },
    })
    expect(minted.statusCode).toBe(200)
    const { token } = minted.json() as { token: string }

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/bookstack/catalog',
      headers: { authorization: `Bearer ${token}` },
      payload: credentials,
    })
    expect(res.statusCode).toBe(403)
  })

  it('import: unknown instance → 400, no or two source keys → 400', async () => {
    expect((await startImport(app, writerSession, space.id, { instance: 'http://bookstack.example.org' })).statusCode).toBe(400)
    expect((await startImport(app, writerSession, space.id, { source: {} })).statusCode).toBe(400)
    expect((await startImport(app, writerSession, space.id, { source: { book: '1', page: 11 } })).statusCode).toBe(400)
  })

  it('import on a space without read → 404', async () => {
    const res = await startImport(app, writerSession, privateSpace.id)
    expect(res.statusCode).toBe(404)
  })

  it('import with read-only access → 403', async () => {
    const res = await startImport(app, readerSession, space.id)
    expect(res.statusCode).toBe(403)
  })

  it('dry-run import runs to done, leaks no secret and revokes its PAT', async () => {
    const res = await startImport(app, writerSession, space.id)
    expect(res.statusCode).toBe(202)
    const { jobId } = res.json() as { jobId: string }

    const job = await waitForJob(writerSession, jobId)
    expect(job.status).toBe('done')
    // Book folder + two pages.
    expect(job.counts.created).toBe(3)
    expect(job.total).toBe(3)
    expect(job.report).toContain('# Import report')

    const raw = JSON.stringify(job)
    expect(raw).not.toContain(TOKEN_SECRET)
    expect(raw).not.toContain('f451_pat_')

    const rows = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, writerUserId), eq(apiTokens.label, `import job ${jobId}`)))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scope).toBe('write')
    expect(rows[0]!.revokedAt).not.toBeNull()
  })

  it('second start for the same user is 409 with the running job id; cancel ends it as cancelled', async () => {
    const first = await startImport(app, writerSession, space.id, { source: { book: '2' } })
    expect(first.statusCode).toBe(202)
    const { jobId } = first.json() as { jobId: string }

    const second = await startImport(app, writerSession, space.id)
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ status: 'conflict', jobId })

    // Another user sees neither the job nor can cancel it.
    const foreignGet = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, cookies: cookiesOf(readerSession) })
    expect(foreignGet.statusCode).toBe(404)
    const foreignCancel = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/cancel`,
      cookies: cookiesOf(readerSession),
    })
    expect(foreignCancel.statusCode).toBe(404)

    const cancel = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, cookies: cookiesOf(writerSession) })
    expect(cancel.statusCode).toBe(200)
    bookstack.releaseBook2()

    const job = await waitForJob(writerSession, jobId)
    expect(job.status).toBe('cancelled')
  })

  it('unknown job id → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/does-not-exist', cookies: cookiesOf(writerSession) })
    expect(res.statusCode).toBe(404)
  })

  describe('file import (#90)', () => {
    const vault = {
      'Welcome.md': '# Welcome\n\nSee [[Detail]] and [[Missing note]].\n',
      'Notes/Detail.md': '---\ntags: [demo]\n---\n# Detail\n\n> [!note] Heads up\n> Body.\n',
    }
    const flags = { format: 'obsidian', update: 'false', release: 'false', dryRun: 'false' }

    async function upload(target: FastifyInstance, session: string, spaceId: string, zip: Buffer, fields = flags) {
      const { payload, headers } = await uploadBody(zip, fields)
      return target.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/import/file`,
        cookies: cookiesOf(session),
        headers,
        payload,
      })
    }

    async function newTempFiles(before: string[]): Promise<string[]> {
      return (await importTempFiles()).filter((n) => !before.includes(n))
    }

    it('a vault ZIP runs to done; pages exist as drafts with open reviews; the temp file is gone', async () => {
      const before = await importTempFiles()
      const res = await upload(app, writerSession, space.id, storedZip(vault))
      expect(res.statusCode).toBe(202)
      const { jobId } = res.json() as { jobId: string }

      const job = await waitForJob(writerSession, jobId)
      expect(job.status).toBe('done')
      expect(job.kind).toBe('import-file')
      // Welcome, the folder page "Notes" and Detail.
      expect(job.counts.created).toBe(3)
      expect(job.counts.failed).toBe(0)
      expect(job.events).toHaveLength(3)
      for (const e of job.events) {
        expect(e.status).toBe('created')
        expect(e.pageId).toBeTruthy()
        expect(e.link).toBe('review')
      }
      expect(job.report).toContain('# Import report')

      expect(await newTempFiles(before)).toEqual([])
    }, 120_000)

    it('an HTML ZIP (format=html) runs to done; pages exist as drafts', async () => {
      const site = {
        'index.html': '<html><head><title>Home</title></head><body><main><h1>Home</h1><p>See <a href="guide.html">the guide</a>.</p></main></body></html>',
        'guide.html': '<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>Text.</p></main></body></html>',
      }
      const res = await upload(app, writerSession, space.id, storedZip(site), { ...flags, format: 'html' })
      expect(res.statusCode).toBe(202)
      const { jobId } = res.json() as { jobId: string }

      const job = await waitForJob(writerSession, jobId)
      expect(job.status).toBe('done')
      expect(job.counts.created).toBe(2)
      expect(job.counts.failed).toBe(0)
      for (const e of job.events) {
        expect(e.status).toBe('created')
        expect(e.pageId).toBeTruthy()
        expect(e.link).toBe('review')
      }
    }, 120_000)

    it('over the upload limit → 413, no temp file left', async () => {
      const before = await importTempFiles()
      const big = Buffer.alloc(1024 * 1024 + 4096, 0x61)
      const res = await upload(appOff, writerSession, space.id, big)
      expect(res.statusCode).toBe(413)
      expect(await newTempFiles(before)).toEqual([])
    })

    it('a zip-slip archive or a non-ZIP → 400 with the reason, no job, no temp file left', async () => {
      const before = await importTempFiles()
      const slip = await upload(app, writerSession, space.id, storedZip({ '../evil.md': '# Evil\n' }))
      expect(slip.statusCode).toBe(400)
      expect(slip.json()).toMatchObject({ status: 'bad_request' })
      expect((slip.json() as { reason: string }).reason).toContain('unsafe path')

      const notZip = await upload(app, writerSession, space.id, Buffer.from('plain text, not an archive'))
      expect(notZip.statusCode).toBe(400)
      expect((notZip.json() as { reason: string }).reason).toContain('not a ZIP')

      expect(await newTempFiles(before)).toEqual([])
    })

    it('bad fields → 400', async () => {
      const zip = storedZip(vault)
      expect((await upload(app, writerSession, space.id, zip, { ...flags, format: 'notion' })).statusCode).toBe(400)
      expect((await upload(app, writerSession, space.id, zip, { ...flags, dryRun: 'yes' })).statusCode).toBe(400)
    })

    it('read-only access → 403, no read access → 404', async () => {
      const zip = storedZip(vault)
      expect((await upload(app, readerSession, space.id, zip)).statusCode).toBe(403)
      expect((await upload(app, writerSession, privateSpace.id, zip)).statusCode).toBe(404)
    })
  })
})
