import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerLocksRoutes, type LocksDeps } from '../src/routes/locks.js'
import { LOCK_TTL_MS } from '../src/drafts/lifecycle.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, spaces as spacesTable, users } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Soft-Lock-Routen `PUT/DELETE /api/locks/:pageId` (Phase 2a Task 4) — gegen
 * echtes PG (Heartbeat-Zeilen, TTL-Logik), Berechtigungs-Gates gestubbt wie
 * in `drafts-routes-permissions.test.ts` (dieselbe `resolveWriteContext`-
 * Kette wird hier nur durchlaufen, nicht erneut in allen Verzweigungen
 * bewiesen — das leistet bereits die Draft-Testsuite).
 */
describe.sequential('Lock-Routen: PUT/DELETE /api/locks/:pageId (Phase 2a Task 4)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'lock-stub-space',
    name: 'Lock Stub Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }
  const pageId = 'home'
  // Zweite Seite für den P1-Regressionstest (Namenskollision) — bewusst
  // getrennt von `pageId`, damit dessen TTL-/Übernahme-Ablauf (der spätere
  // Tests konsumieren) unberührt bleibt.
  const collisionPageId = 'collision-page'

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })
    await db.insert(pages).values([
      { id: pageId, spaceId: space.id, path: 'index.md', ref: 'main', title: 'Home', lang: 'de' },
      {
        id: collisionPageId, spaceId: space.id, path: 'collision.md', ref: 'main',
        title: 'Kollision', lang: 'de',
      },
    ])
    // `locks.userId` ist seit dem P1-Fix eine NOT-NULL-FK auf `users.id` — alle
    // in diesem Suite verwendeten Test-Nutzer-Ids brauchen daher eine echte
    // `users`-Zeile (sonst schlägt der Lock-Insert am FK-Constraint fehl).
    await db.insert(users).values([
      { id: 'alice', email: 'alice@test.local', displayName: 'Alice' },
      { id: 'bob', email: 'bob@test.local', displayName: 'Bob' },
      { id: 'carol-1', email: 'carol-1@test.local', displayName: 'Carol' },
      { id: 'carol-2', email: 'carol-2@test.local', displayName: 'Carol' },
    ])
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  function buildTestApp(deps: LocksDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    // Test-Stub statt echter Session (wie drafts-routes-permissions.test.ts):
    // Nutzer-Id UND displayName kommen aus Headern.
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      const displayName = req.headers['x-test-display-name']
      req.user =
        typeof userId === 'string' && typeof displayName === 'string'
          ? { id: userId, email: `${userId}@test.local`, displayName }
          : null
    })
    registerLocksRoutes(app, deps)
    return app
  }

  function fullAccessDeps(): LocksDeps {
    return {
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => ({}) as never, // nicht aufgerufen (Lock-Routen brauchen keinen Provider)
    }
  }

  const userHeaders = (id: string, displayName: string) => ({
    'x-test-user': id,
    'x-test-display-name': displayName,
  })

  it('unbekannte Seite → 404 (Gate wiederverwendet, kein Lock angelegt)', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/locks/does-not-exist',
      headers: userHeaders('alice', 'Alice'),
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('kein Schreibrecht (canWrite=false) → 403, kein Lock angelegt', async () => {
    const app = buildTestApp({ ...fullAccessDeps(), canWrite: async () => false })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('alice', 'Alice'),
    })
    expect(res.statusCode).toBe(403)
    const rows = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(rows).toHaveLength(0)
    await app.close()
  })

  it('PUT ohne bestehenden Lock: legt ihn an, heldBy=eigener Name, expiresAt in der Zukunft, mine=true', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()
    const before = Date.now()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('alice', 'Alice'),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.heldBy).toBe('Alice')
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(before + LOCK_TTL_MS - 1000)
    // `mine` wird serverseitig gegen `req.user.id` berechnet — der eigene
    // frisch angelegte Lock muss sich selbst als "mine" erkennen.
    expect(body.mine).toBe(true)

    await app.close()
  })

  it('Heartbeat verlängert: erneutes PUT desselben Nutzers verschiebt expiresAt nach hinten', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()

    const first = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('alice', 'Alice'),
    })
    const firstExpiry = new Date(first.json().expiresAt).getTime()

    await new Promise((r) => setTimeout(r, 20))

    const second = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('alice', 'Alice'),
    })
    expect(second.statusCode).toBe(200)
    const secondExpiry = new Date(second.json().expiresAt).getTime()
    expect(secondExpiry).toBeGreaterThan(firstExpiry)
    expect(second.json().heldBy).toBe('Alice')

    const rows = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(rows).toHaveLength(1)

    await app.close()
  })

  it('fremder frischer Lock wird gemeldet, aber NICHT überschrieben; mine=false aus Bobs Perspektive', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()

    // Alice hält (aus dem vorigen Test) bereits einen frischen Lock.
    const bobRes = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('bob', 'Bob'),
    })
    expect(bobRes.statusCode).toBe(200)
    expect(bobRes.json().heldBy).toBe('Alice')
    // Bob bekommt NIE Alices userId, aber weiß über `mine`, dass der Lock nicht ihm gehört.
    expect(bobRes.json().mine).toBe(false)

    const rows = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userName).toBe('Alice')
    expect(rows[0]?.userId).toBe('alice')

    await app.close()
  })

  it('abgelaufener fremder Lock (>2 min) wird beim Heartbeat übernommen', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()

    // Alices Lock künstlich veralten lassen (>2 min, Plan Global Constraints TTL).
    const staleHeartbeat = new Date(Date.now() - (LOCK_TTL_MS + 60_000))
    await db.update(locks).set({ heartbeatAt: staleHeartbeat }).where(eq(locks.pageId, pageId))

    const bobRes = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('bob', 'Bob'),
    })
    expect(bobRes.statusCode).toBe(200)
    expect(bobRes.json().heldBy).toBe('Bob')

    const rows = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userName).toBe('Bob')

    await app.close()
  })

  it('DELETE löst NUR den eigenen Lock: fremder Versuch bleibt wirkungslos', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()

    // Bob hält den Lock (aus dem vorigen Test). Alice versucht, ihn zu löschen.
    const aliceDelete = await app.inject({
      method: 'DELETE',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('alice', 'Alice'),
    })
    expect(aliceDelete.statusCode).toBe(204)

    const stillThere = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0]?.userName).toBe('Bob')

    // Bob löst seinen eigenen Lock erfolgreich.
    const bobDelete = await app.inject({
      method: 'DELETE',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('bob', 'Bob'),
    })
    expect(bobDelete.statusCode).toBe(204)

    const gone = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(gone).toHaveLength(0)

    await app.close()
  })

  it('DELETE ohne bestehenden Lock ist idempotent → 204', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/locks/${pageId}`,
      headers: userHeaders('alice', 'Alice'),
    })
    expect(res.statusCode).toBe(204)
    await app.close()
  })

  it('DELETE unbekannte Seite → 404 (Gate wiederverwendet)', async () => {
    const app = buildTestApp(fullAccessDeps())
    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/locks/does-not-exist',
      headers: userHeaders('alice', 'Alice'),
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  describe('P1-Regressionstest: Namenskollision (gleicher displayName, andere userId)', () => {
    // Der 2a-Bug: `upsertLock`/DELETE verglichen früher über `userName` (den
    // NICHT-eindeutigen OIDC-`name`-Claim) statt über `userId`. Zwei Konten
    // mit demselben Anzeigenamen "Carol" konnten sich so gegenseitig den Lock
    // stehlen bzw. löschen. Dieser Test beweist den Fix: `carol-2` (anderer
    // Account, gleicher Anzeigename) darf `carol-1`s frischen Lock weder
    // übernehmen noch löschen.
    it('zweiter Nutzer mit identischem displayName kann fremden frischen Lock NICHT übernehmen', async () => {
      const app = buildTestApp(fullAccessDeps())
      await app.ready()

      const first = await app.inject({
        method: 'PUT',
        url: `/api/locks/${collisionPageId}`,
        headers: userHeaders('carol-1', 'Carol'),
      })
      expect(first.statusCode).toBe(200)
      expect(first.json()).toMatchObject({ heldBy: 'Carol', mine: true })

      // "carol-2" trägt denselben Anzeigenamen, ist aber ein ANDERES Konto
      // (andere userId) — der Heartbeat darf den bestehenden, frischen Lock
      // NICHT übernehmen (das WÜRDE bei einem Vergleich über userName passieren).
      const imposter = await app.inject({
        method: 'PUT',
        url: `/api/locks/${collisionPageId}`,
        headers: userHeaders('carol-2', 'Carol'),
      })
      expect(imposter.statusCode).toBe(200)
      expect(imposter.json()).toMatchObject({ heldBy: 'Carol', mine: false })

      const rows = await db.select().from(locks).where(eq(locks.pageId, collisionPageId))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe('carol-1')

      await app.close()
    })

    it('zweiter Nutzer mit identischem displayName kann fremden Lock NICHT löschen', async () => {
      const app = buildTestApp(fullAccessDeps())
      await app.ready()

      // Lock gehört weiterhin carol-1 (aus dem vorigen Test).
      const imposterDelete = await app.inject({
        method: 'DELETE',
        url: `/api/locks/${collisionPageId}`,
        headers: userHeaders('carol-2', 'Carol'),
      })
      // Idempotent-Vertrag (DELETE meldet nie, ob fremd oder nicht vorhanden) →
      // 204, aber OHNE Wirkung auf einen fremden Lock.
      expect(imposterDelete.statusCode).toBe(204)

      const stillThere = await db.select().from(locks).where(eq(locks.pageId, collisionPageId))
      expect(stillThere).toHaveLength(1)
      expect(stillThere[0]?.userId).toBe('carol-1')
      expect(stillThere[0]?.userName).toBe('Carol')

      // Die echte Besitzerin (carol-1) kann ihren eigenen Lock weiterhin lösen.
      const ownerDelete = await app.inject({
        method: 'DELETE',
        url: `/api/locks/${collisionPageId}`,
        headers: userHeaders('carol-1', 'Carol'),
      })
      expect(ownerDelete.statusCode).toBe(204)

      const gone = await db.select().from(locks).where(eq(locks.pageId, collisionPageId))
      expect(gone).toHaveLength(0)

      await app.close()
    })
  })

  describe('Phase 2d Task 5 Regression: Draft-only-Seite (per POST /api/pages angelegt, KEINE ref=main-Zeile)', () => {
    const draftOnlyPageId = 'draft-only-lock-page'

    it(
      'PUT legt den Lock mit ref=draft an (statt hartkodiert ref=main) — sonst würde die FK-Constraint ' +
        '(locks.pageId, locks.ref) → pages(id, ref) verletzt, weil für diese Seite nur eine ref=draft-Zeile ' +
        'existiert; DELETE funktioniert über denselben resolveWriteContext-Draft-only-Fallback',
      async () => {
        await db.insert(pages).values({
          id: draftOnlyPageId,
          spaceId: space.id,
          path: 'draft-only-lock-page/index.md',
          ref: 'draft',
          title: 'Draft-only Lock',
          lang: 'de',
        })

        const app = buildTestApp(fullAccessDeps())
        await app.ready()

        const putRes = await app.inject({
          method: 'PUT',
          url: `/api/locks/${draftOnlyPageId}`,
          headers: userHeaders('alice', 'Alice'),
        })
        expect(putRes.statusCode).toBe(200)
        expect(putRes.json()).toMatchObject({ heldBy: 'Alice', mine: true })

        const rows = await db.select().from(locks).where(eq(locks.pageId, draftOnlyPageId))
        expect(rows).toHaveLength(1)
        expect(rows[0]?.ref).toBe('draft')

        const deleteRes = await app.inject({
          method: 'DELETE',
          url: `/api/locks/${draftOnlyPageId}`,
          headers: userHeaders('alice', 'Alice'),
        })
        expect(deleteRes.statusCode).toBe(204)

        const gone = await db.select().from(locks).where(eq(locks.pageId, draftOnlyPageId))
        expect(gone).toHaveLength(0)

        await app.close()
      },
    )
  })
})
