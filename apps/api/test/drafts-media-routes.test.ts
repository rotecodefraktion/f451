import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 5).toString('base64')

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))
function fixtureBuffer(name: string): Buffer {
  return readFileSync(`${fixturesDir}${name}`)
}

/** Baut einen echten `multipart/form-data`-Request-Body (Feld `file`) über die
 *  in Node global verfügbare, undici-basierte `FormData`/`Request` — liefert
 *  Body-Buffer und den passenden `content-type`-Header (inkl. Boundary) für
 *  `app.inject()`. Keine zusätzliche Test-Dependency nötig. */
async function multipartBody(
  filename: string,
  buffer: Buffer,
  mimetype = 'application/octet-stream',
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), filename)
  const req = new Request('http://upload.local/', { method: 'POST', body: form })
  const payload = Buffer.from(await req.arrayBuffer())
  const contentType = req.headers.get('content-type')!
  return { payload, contentType }
}

/**
 * `POST /api/pages/:id/draft/media` (Phase 2a Task 5) — end-to-end gegen
 * einen echten Forgejo-Container: PNG-Happy-Path, Magic-Bytes-Ablehnung,
 * SVG-Sanitizing, Größenlimit, Kollisions-Suffix, Berechtigungs-Gates.
 */
describe.sequential('Draft-Medien-Route: POST /api/pages/:id/draft/media (Phase 2a Task 5)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: FastifyInstance

  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'media-writer'
  const readerUserId = 'media-reader-only'

  let writerSession: string
  let readerSession: string

  const pageId = 'anleitung'
  const pagePath = 'betrieb/anleitung/index.md'
  const branch = draftBranchName(pageId)

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('media-routes', { private: false })
    await provider.writeFile(repo, pagePath, '---\nid: anleitung\ntitle: Anleitung\nlang: de\n---\n# Anleitung\n', {
      branch: 'main',
      message: 'seed',
    })

    space = {
      id: 'media-routes-space',
      name: 'Media Routes',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    writer = await forgejo.createUser('media-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('media-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'media-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'media-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      // Kleines Limit (1 MiB), damit der 413-Test ohne einen mehrere-MB-
      // großen Puffer auskommt.
      maxUploadMb: 1,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await app.ready()

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id

    // Draft-Branch muss existieren (Upload legt ihn NIE selbst an, analog zu
    // Autosave) — wie ein Nutzer, der die Seite zum Bearbeiten öffnet.
    const openRes = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: { [SESSION_COOKIE_NAME]: writerSession },
    })
    expect(openRes.statusCode).toBe(200)
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  it('PNG-Upload (Happy Path): 200 mit path/markdown, Datei liegt auf dem Draft-Branch', async () => {
    const { payload, contentType } = await multipartBody('Diagramm.png', fixtureBuffer('minimal.png'), 'image/png')

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      path: '_media/diagramm.png',
      markdown: '![](_media/diagramm.png)',
      kind: 'image',
    })

    const committed = await provider.readFileBinary(repo, 'betrieb/anleitung/_media/diagramm.png', branch)
    expect(committed.content).toEqual(fixtureBuffer('minimal.png'))

    const commits = await provider.listCommits(repo, {
      ref: branch,
      path: 'betrieb/anleitung/_media/diagramm.png',
      limit: 1,
    })
    // Nutzer-Token (echte Autorschaft, kein Bot) — wie beim Autosave.
    expect(commits[0]?.authorEmail).toBe(`${writer.username}@test.local`)
  })

  it('PDF-Upload (Happy Path, Editor-Erweiterung „Datei-Anhänge"): 200 mit kind "file" und Link-Markdown', async () => {
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(16)])
    const { payload, contentType } = await multipartBody('Handbuch.pdf', pdfBytes, 'application/pdf')

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      path: '_media/handbuch.pdf',
      markdown: '[Handbuch.pdf](_media/handbuch.pdf)',
      kind: 'file',
    })

    const committed = await provider.readFileBinary(repo, 'betrieb/anleitung/_media/handbuch.pdf', branch)
    expect(committed.content).toEqual(pdfBytes)
  })

  it('fake .pdf mit fremdem Inhalt → 415 (Magic-Bytes-Prüfung greift auch für Dokument-Anhänge)', async () => {
    const { payload, contentType } = await multipartBody(
      'fake.pdf',
      Buffer.from('<html><body>kein PDF</body></html>'),
      'application/pdf',
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(415)
    expect(res.json().reason).toBeTruthy()
  })

  it('fake .png mit HTML-Inhalt → 415 (Magic-Bytes-Prüfung)', async () => {
    const { payload, contentType } = await multipartBody(
      'fake.png',
      Buffer.from('<html><body>kein Bild</body></html>'),
      'image/png',
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(415)
    expect(res.json().reason).toBeTruthy()
  })

  it('SVG mit Skript: 200, committete Datei enthält kein <script/onload', async () => {
    const { payload, contentType } = await multipartBody('boese.svg', fixtureBuffer('script.svg'), 'image/svg+xml')

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().path).toBe('_media/boese.svg')

    const committed = await provider.readFileBinary(repo, 'betrieb/anleitung/_media/boese.svg', branch)
    const text = committed.content.toString('utf8')
    expect(text).not.toContain('<script')
    expect(text).not.toContain('onload')
    expect(text.toLowerCase()).not.toContain('javascript:')
  })

  it('SVG, das nach dem Sanitizing leer ist → 422, kein Commit', async () => {
    const { payload, contentType } = await multipartBody(
      'leer.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'image/svg+xml',
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(422)
    await expect(provider.readFileBinary(repo, 'betrieb/anleitung/_media/leer.svg', branch)).rejects.toThrow()
  })

  it('draw.io-SVG: 200, committete Datei behält das content-Attribut (mxfile)', async () => {
    const { payload, contentType } = await multipartBody(
      'architektur.svg',
      fixtureBuffer('drawio.svg'),
      'image/svg+xml',
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(200)
    const committed = await provider.readFileBinary(repo, 'betrieb/anleitung/_media/architektur.svg', branch)
    const text = committed.content.toString('utf8')
    expect(text).toContain('mxfile')
    expect(text).toContain('<metadata')
  })

  it('Größenlimit überschritten → 413', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1) // 2 MiB > 1 MiB Limit dieser Suite
    const { payload, contentType } = await multipartBody('gross.png', big, 'image/png')

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(413)
  })

  it('Kollision: zweiter Upload desselben Namens → -1-Suffix', async () => {
    const { payload, contentType } = await multipartBody('kollision.png', fixtureBuffer('minimal.png'), 'image/png')
    const first = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().path).toBe('_media/kollision.png')

    const second = await multipartBody('kollision.png', fixtureBuffer('minimal.png'), 'image/png')
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': second.contentType },
      payload: second.payload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().path).toBe('_media/kollision-1.png')
  })

  it('kein multipart/form-data-Body → 400 (kein 502, kein Provider-Aufruf)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ irrelevant: true }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('multipart-Body ohne Feld "file" → 400', async () => {
    const form = new FormData()
    form.append('anderesFeld', 'wert')
    const req = new Request('http://upload.local/', { method: 'POST', body: form })
    const payload = Buffer.from(await req.arrayBuffer())
    const contentType = req.headers.get('content-type')!

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('Nur-Lese-Collaborator ohne Schreibrecht → 403, kein Commit', async () => {
    const { payload, contentType } = await multipartBody('verboten.png', fixtureBuffer('minimal.png'), 'image/png')

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies: cookiesOf(readerSession),
      headers: { 'content-type': contentType },
      payload,
    })

    expect(res.statusCode).toBe(403)
    await expect(
      provider.readFileBinary(repo, 'betrieb/anleitung/_media/verboten.png', branch),
    ).rejects.toThrow()
  })

  it('unbekannte Seite → 404', async () => {
    const { payload, contentType } = await multipartBody('x.png', fixtureBuffer('minimal.png'), 'image/png')
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/does-not-exist/draft/media',
      cookies: cookiesOf(writerSession),
      headers: { 'content-type': contentType },
      payload,
    })
    expect(res.statusCode).toBe(404)
  })

  it('ohne Session → 401', async () => {
    const { payload, contentType } = await multipartBody('x.png', fixtureBuffer('minimal.png'), 'image/png')
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      headers: { 'content-type': contentType },
      payload,
    })
    expect(res.statusCode).toBe(401)
  })
})
