import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, NotFoundError, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

/**
 * `DELETE /api/pages/:id` (Feature „Seite löschen") — durchgehend über
 * `buildApp`/`app.inject()` gegen echten Forgejo- und PG-Container (Muster
 * `create-page.test.ts`): Gate-Kette, Löschung der main-Datei per Commit,
 * Aufräumen von Index/Lock/Draft-Branch, sowie der Draft-only-Fall (Seite nie
 * released, kein main-Commit zu löschen).
 */
describe.sequential('DELETE /api/pages/:id: Seite löschen', () => {
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
  const writerUserId = 'dp-writer'
  const readerUserId = 'dp-reader'

  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('delete-page', { private: false })
    await provider.writeFile(repo, 'index.md', '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n', {
      branch: 'main',
      message: 'seed',
    })
    await provider.writeFile(
      repo,
      'loeschen/index.md',
      '---\nid: loeschen\ntitle: Löschkandidat\nlang: de\n---\n# Löschkandidat\n',
      { branch: 'main', message: 'seed' },
    )
    await provider.writeFile(
      repo,
      'mit-draft/index.md',
      '---\nid: mit-draft\ntitle: Mit Entwurf\nlang: de\n---\n# Mit Entwurf\n',
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'delete-page-space', name: 'Delete Page', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    writer = await forgejo.createUser('dp-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('dp-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'dp-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'dp-reader@example.org', displayName: 'Reader' },
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
    const res = await app.inject({ method: 'DELETE', url: '/api/pages/loeschen' })
    expect(res.statusCode).toBe(401)
  })

  it('unbekannte Seite → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/pages/gibt-es-nicht',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(404)
  })

  it('Nur-Lese-Collaborator → 403 ohne connect-Hinweis', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/pages/loeschen',
      cookies: cookiesOf(readerSession),
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it(
    'Happy Path: löscht die main-Datei per Commit, entfernt die Index-Zeile, antwortet 200 {ok:true}',
    async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/pages/loeschen',
        cookies: cookiesOf(writerSession),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })

      await expect(provider.readFile(repo, 'loeschen/index.md', 'main')).rejects.toBeInstanceOf(NotFoundError)

      const rows = await db.select().from(pages).where(eq(pages.id, 'loeschen'))
      expect(rows).toHaveLength(0)

      // Erneutes Löschen (Seite jetzt unbekannt) → 404, kein Doppel-Commit.
      const again = await app.inject({
        method: 'DELETE',
        url: '/api/pages/loeschen',
        cookies: cookiesOf(writerSession),
      })
      expect(again.statusCode).toBe(404)
    },
  )

  it('löscht eine Seite MIT offenem Draft: Draft-Branch, Draft-Index-Zeile und Lock verschwinden mit', async () => {
    const draftRes = await app.inject({
      method: 'POST',
      url: '/api/pages/mit-draft/draft',
      cookies: cookiesOf(writerSession),
    })
    expect(draftRes.statusCode).toBe(200)
    const branch = draftBranchName('mit-draft')
    await expect(provider.getHeadSha(repo, branch)).resolves.toMatch(/^[0-9a-f]{40}$/)

    // Ein Autosave erzeugt eine `ref='draft'`-Indexzeile UND (über den
    // Lock-Heartbeat des Editors, hier direkt simuliert) einen Lock-Datensatz
    // — beide müssen mit verschwinden.
    await db.insert(locks).values({ pageId: 'mit-draft', userId: writerUserId, userName: 'Writer' })

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/pages/mit-draft',
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    await expect(provider.getHeadSha(repo, branch)).rejects.toBeInstanceOf(NotFoundError)
    const rows = await db.select().from(pages).where(eq(pages.id, 'mit-draft'))
    expect(rows).toHaveLength(0)
    const lockRows = await db.select().from(locks).where(eq(locks.pageId, 'mit-draft'))
    expect(lockRows).toHaveLength(0)
  })

  it('löscht eine Draft-only-Seite (nie released): kein main-Commit nötig, Draft-Branch/-Zeile verschwinden trotzdem', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Nie Released' },
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as { id: string; branch: string }

    const draftRows = await db.select().from(pages).where(and(eq(pages.id, created.id), eq(pages.ref, 'draft')))
    expect(draftRows).toHaveLength(1)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${encodeURIComponent(created.id)}`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    await expect(provider.getHeadSha(repo, created.branch)).rejects.toBeInstanceOf(NotFoundError)
    const rowsAfter = await db.select().from(pages).where(eq(pages.id, created.id))
    expect(rowsAfter).toHaveLength(0)
  })
})
