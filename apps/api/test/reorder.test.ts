import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, NotFoundError, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')

interface ReorderResponse {
  parentId: string | null
  path: string
  orderedIds: string[]
}

/**
 * `PUT /api/spaces/:space/order` (Phase 3.3, „Baum-Umsortierung über
 * `.order`-Dateien") — durchgehend über `buildApp`/`app.inject()` gegen echten
 * Forgejo- und PG-Container (Muster `move-page.test.ts`): Gate-Kette,
 * `.order`-Datei anlegen/aktualisieren, gezieltes `orderKey`-Update
 * (inkl. Zurücksetzen NICHT genannter Geschwister auf `null`), Validierung
 * (Fremd-Id/Duplikat → 400), Space-Wurzel (`parentId: null`) und unbekannte
 * `parentId` (404).
 */
describe.sequential('PUT /api/spaces/:space/order: Baum-Umsortierung (Phase 3.3)', () => {
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
  const writerUserId = 'ro-writer'
  const readerUserId = 'ro-reader'

  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('reorder', { private: false })

    const seed = async (path: string, id: string, title: string) => {
      await provider.writeFile(repo, path, `---\nid: ${id}\ntitle: ${title}\nlang: de\n---\n# ${title}\n`, {
        branch: 'main',
        message: 'seed',
      })
    }

    await seed('index.md', 'home', 'Home')

    // Kinder von `betrieb`: KEIN bestehendes `.order` — Reorder-Aufruf legt es neu an.
    await seed('betrieb/index.md', 'betrieb', 'Betrieb')
    await seed('betrieb/alpha/index.md', 'alpha', 'Alpha')
    await seed('betrieb/beta/index.md', 'beta', 'Beta')
    await seed('betrieb/gamma/index.md', 'gamma', 'Gamma')

    // Kinder von `mit-order`: BEREITS ein `.order` vorhanden — Reorder-Aufruf
    // muss die bestehende Datei aktualisieren (writeFile MIT sha).
    await seed('mit-order/index.md', 'mit-order', 'Mit Order')
    await seed('mit-order/x/index.md', 'mo-x', 'X')
    await seed('mit-order/y/index.md', 'mo-y', 'Y')
    await provider.writeFile(repo, 'mit-order/.order', 'mo-y\nmo-x\n', { branch: 'main', message: 'seed order' })

    space = {
      id: 'reorder-space', name: 'Reorder', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    writer = await forgejo.createUser('ro-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('ro-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'ro-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'ro-reader@example.org', displayName: 'Reader' },
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
  const orderKeyOf = async (id: string): Promise<number | null> => {
    const row = (await db.select().from(pages).where(and(eq(pages.id, id), eq(pages.ref, 'main'))))[0]!
    return row.orderKey
  }

  it('ohne Session → 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      payload: { parentId: 'betrieb', orderedIds: ['gamma', 'alpha'] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('Nur-Lese-Collaborator → 403 ohne connect-Hinweis', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(readerSession),
      payload: { parentId: 'betrieb', orderedIds: ['gamma', 'alpha'] },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it('unbekannter Space → 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/spaces/gibt-es-nicht/order',
      cookies: cookiesOf(writerSession),
      payload: { parentId: null, orderedIds: [] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('unbekannte parentId → 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'gibt-es-nicht', orderedIds: [] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Fremd-Id (kein tatsächliches Kind) → 400, kein Commit', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'betrieb', orderedIds: ['gamma', 'mo-x'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toBeTruthy()
    await expect(provider.readFile(repo, 'betrieb/.order', 'main')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('doppelte Id in orderedIds → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'betrieb', orderedIds: ['gamma', 'gamma'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it(
    'legt eine neue `.order`-Datei an (kein Commit vorher), aktualisiert orderKey gezielt — ' +
      'ein Kind OHNE Eintrag (hier: beta) wird explizit auf null zurückgesetzt',
    async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/spaces/${space.id}/order`,
        cookies: cookiesOf(writerSession),
        payload: { parentId: 'betrieb', orderedIds: ['gamma', 'alpha'] },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as ReorderResponse
      expect(body).toEqual({ parentId: 'betrieb', path: 'betrieb/.order', orderedIds: ['gamma', 'alpha'] })

      const written = await provider.readFile(repo, 'betrieb/.order', 'main')
      expect(written.content).toBe('gamma\nalpha\n')

      expect(await orderKeyOf('gamma')).toBe(0)
      expect(await orderKeyOf('alpha')).toBe(1)
      expect(await orderKeyOf('beta')).toBeNull()
    },
  )

  it('aktualisiert eine BEREITS bestehende `.order`-Datei (writeFile mit sha, kein Konflikt)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'mit-order', orderedIds: ['mo-x', 'mo-y'] },
    })
    expect(res.statusCode).toBe(200)

    const written = await provider.readFile(repo, 'mit-order/.order', 'main')
    expect(written.content).toBe('mo-x\nmo-y\n')
    expect(await orderKeyOf('mo-x')).toBe(0)
    expect(await orderKeyOf('mo-y')).toBe(1)
  })

  it('Space-Wurzel (`parentId: null`) ordnet die Kinder der Startseite', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(writerSession),
      payload: { parentId: null, orderedIds: ['mit-order', 'betrieb'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ReorderResponse
    expect(body).toEqual({ parentId: null, path: '.order', orderedIds: ['mit-order', 'betrieb'] })

    const written = await provider.readFile(repo, '.order', 'main')
    expect(written.content).toBe('mit-order\nbetrieb\n')
    expect(await orderKeyOf('mit-order')).toBe(0)
    expect(await orderKeyOf('betrieb')).toBe(1)
  })

  it('leere orderedIds löscht eine bestehende `.order`-Datei (kein Sinn in einer leeren Datei)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/order`,
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'betrieb', orderedIds: [] },
    })
    expect(res.statusCode).toBe(200)
    await expect(provider.readFile(repo, 'betrieb/.order', 'main')).rejects.toBeInstanceOf(NotFoundError)
    expect(await orderKeyOf('gamma')).toBeNull()
    expect(await orderKeyOf('alpha')).toBeNull()
  })
})
