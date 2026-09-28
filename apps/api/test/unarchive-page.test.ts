import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')

/**
 * `POST /api/pages/:id/unarchive` (Feature „Unarchive") — durchgehend über
 * `buildApp`/`app.inject()` gegen echten Forgejo- und PG-Container (Muster
 * `move-page.test.ts`/`delete-page.test.ts`): Gate-Kette, entfernt `archived`
 * aus dem Frontmatter DIREKT auf `main`, Draft-/Lock-Blockade (409), Reindex.
 */
describe.sequential('POST /api/pages/:id/unarchive: Seite aus dem Archiv holen', () => {
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
  const writerUserId = 'ua-writer'
  const readerUserId = 'ua-reader'

  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('unarchive-page', { private: false })

    const seed = async (path: string, id: string, title: string, extraFrontmatter = '', body?: string) => {
      await provider.writeFile(
        repo,
        path,
        `---\nid: ${id}\ntitle: ${title}\nlang: de\n${extraFrontmatter}---\n${body ?? `# ${title}\n`}`,
        { branch: 'main', message: 'seed' },
      )
    }

    await seed('index.md', 'home', 'Home')

    // Happy Path: archivierte Seite.
    await seed('archiviert/index.md', 'archiviert', 'Archiviert', 'archived: true\n')

    // Draft-Blockade.
    await seed('blockiert/index.md', 'blockiert', 'Blockiert', 'archived: true\n')

    // Lock-Blockade.
    await seed('gesperrt/index.md', 'gesperrt', 'Gesperrt', 'archived: true\n')

    // Nicht archiviert (unarchivieren ist trotzdem ein No-Op-Erfolg, keine
    // eigene Vorbedingung „muss archived sein").
    await seed('nicht-archiviert/index.md', 'nicht-archiviert', 'Nicht Archiviert')

    space = {
      id: 'unarchive-page-space', name: 'Unarchive Page', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    writer = await forgejo.createUser('ua-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('ua-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'ua-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'ua-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await app.ready()

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  it('ohne Session → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages/archiviert/unarchive' })
    expect(res.statusCode).toBe(401)
  })

  it('unbekannte Seite → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/gibt-es-nicht/unarchive',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })

  it('Nur-Lese-Collaborator → 403 ohne connect-Hinweis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/archiviert/unarchive',
      cookies: cookiesOf(readerSession),
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it('entfernt `archived` aus dem Frontmatter DIREKT auf main, andere Felder bleiben erhalten', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/archiviert/unarchive',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'archiviert', path: 'archiviert/index.md' })

    const file = await provider.readFile(repo, 'archiviert/index.md', 'main')
    expect(file.content).not.toContain('archived')
    expect(file.content).toContain('id: archiviert')
    expect(file.content).toContain('title: Archiviert')
    expect(file.content).toContain('lang: de')

    // Reindex: die `pages`-Zeile (ref=main) spiegelt den neuen Status.
    const rows = await db.select().from(pages).where(eq(pages.id, 'archiviert'))
    const mainRow = rows.find((r) => r.ref === 'main')
    expect(mainRow?.archived).toBe(false)
  })

  it('nicht archivierte Seite → 200, No-Op (kein `archived`-Feld weder vorher noch nachher)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/nicht-archiviert/unarchive',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)

    const file = await provider.readFile(repo, 'nicht-archiviert/index.md', 'main')
    expect(file.content).not.toContain('archived')
  })

  it('Draft-Blockade: offener Entwurf → 409, main bleibt unangetastet', async () => {
    const draftRes = await app.inject({
      method: 'POST',
      url: '/api/pages/blockiert/draft',
      cookies: cookiesOf(writerSession),
    })
    expect(draftRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/blockiert/unarchive',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().reason).toBeTruthy()

    const file = await provider.readFile(repo, 'blockiert/index.md', 'main')
    expect(file.content).toContain('archived: true')
  })

  it('Lock-Blockade (ohne Draft-Branch, nur aktiver Lock) → 409', async () => {
    await db.insert(users).values({ id: 'ua-locker', email: 'ua-locker@example.org', displayName: 'Locker' })
    await db.insert(locks).values({ pageId: 'gesperrt', userId: 'ua-locker', userName: 'Locker' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/gesperrt/unarchive',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(409)

    const file = await provider.readFile(repo, 'gesperrt/index.md', 'main')
    expect(file.content).toContain('archived: true')

    await db.delete(locks).where(eq(locks.pageId, 'gesperrt'))
  })

  it('Draft-only-Seite (nie released) → 404 (nichts auf main zu unarchivieren)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Nie Released Unarchive' },
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as { id: string }

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${encodeURIComponent(created.id)}/unarchive`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })
})
