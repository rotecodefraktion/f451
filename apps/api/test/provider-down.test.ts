import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { registerDraftsRoutes, type DraftsDeps } from '../src/routes/drafts.js'
import { registerPagesRoutes, type PagesDeps } from '../src/routes/pages.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Spec-§11-Abnahme, Störungs-Drehbuch (a) „Provider down" (Task 5): beweist
 * die drei im Betriebs-Drehbuch (`deploy/BETRIEB.md`) beschriebenen Fälle,
 * wenn der Git-Provider (Forgejo/GitHub) komplett ausfällt — ECONNREFUSED-
 * artig, jede Methode wirft. Zwei der drei Fälle sind bereits an anderer
 * Stelle bewiesen und werden hier NUR referenziert statt dupliziert:
 *
 *  - `GET /api/pages/:id` (indexierte Seite) → 200, `workflow:null`:
 *    `pages-routes.test.ts`, Test „Provider-Ausfall beim Zustandsermitteln
 *    → workflow null, Seite selbst bleibt 200 (Lesen fällt nie aus)" —
 *    Kernaussage identisch (Lesen degradiert, statt zu scheitern), inklusive
 *    HTML/Index-Feldern aus der DB.
 *  - Provider-Fehler beim Rohtext-Lesen (`GET /api/pages/:id/raw`) → 502
 *    `{status,reason}`: `read-api.test.ts`, Test „Provider-Fehler beim Lesen
 *    → 502 mit Meldung".
 *
 * Neu hier: `GET /api/spaces/:space/tree` (beweist, dass die Route den
 * Provider NIE berührt — reiner Index-Pfad) und `POST /api/pages/:id/draft`
 * (Schreibpfad, muss bei Provider-Ausfall sauber mit 502 `{status,reason}`
 * statt 500 antworten). Muster wie `pages-routes.test.ts`/
 * `drafts-routes-permissions.test.ts`: `register*Routes` direkt auf einer
 * schlanken `Fastify()`-Instanz mit gestubbten Deps, `x-test-user`-Header
 * statt echter Session — isoliert die Degradation von Auth-/Provider-
 * Mechanik.
 */
describe.sequential('Störungs-Drehbuch (a): Provider down (Spec §11-Abnahme)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'provider-down-space',
    name: 'Provider Down Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }
  const pageId = 'home'
  const pagePath = 'index.md'

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })
    await db.insert(pages).values({
      id: pageId, spaceId: space.id, path: pagePath, ref: 'main', title: 'Home', lang: 'de',
      htmlRendered: '<h1>Home</h1>',
    })
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  /** Jede Methode wirft einen ECONNREFUSED-artigen Fehler — simuliert einen
   *  vollständigen Provider-Totalausfall (Netz weg, nicht bloß ein einzelner
   *  Endpunkt). */
  function providerDown(): GitProvider {
    const fail = (): never => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3001 (simulierter Provider-Totalausfall)')
    }
    return {
      readFile: fail, readFileBinary: fail, listTree: fail, getHeadSha: fail, writeFile: fail,
      writeFileBinary: fail, createBranch: fail, deleteBranch: fail, listCommits: fail,
      createPullRequest: fail, getPullRequest: fail, mergePullRequest: fail,
    }
  }

  function buildPagesTestApp(deps: PagesDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerPagesRoutes(app, deps)
    return app
  }

  function buildDraftsTestApp(deps: DraftsDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerDraftsRoutes(app, deps)
    return app
  }

  it(
    'GET /api/spaces/:space/tree bleibt bei Provider-Totalausfall unberührt → 200 mit vollständigem ' +
      'Baum: die Route liest ausschließlich aus dem Index (DB), der GitProvider wird nie aufgerufen',
    async () => {
      const app = buildPagesTestApp({
        db,
        spaces: [space],
        providerRegistry: () => providerDown(),
      })
      await app.ready()
      const res = await app.inject({ method: 'GET', url: `/api/spaces/${space.id}/tree` })
      expect(res.statusCode).toBe(200)
      const tree = res.json() as Array<{ id: string; path: string }>
      expect(tree).toHaveLength(1)
      expect(tree[0]?.id).toBe(pageId)
      expect(tree[0]?.path).toBe(pagePath)
      await app.close()
    },
  )

  it(
    'POST /api/pages/:id/draft bei Provider-Totalausfall (ECONNREFUSED-artig) → 502 {status,reason} ' +
      '(kein 500) — Schreibpfad degradiert kontrolliert statt abzustürzen',
    async () => {
      const app = buildDraftsTestApp({
        db,
        spaces: [space],
        access: { canRead: async () => true },
        canWrite: async () => true,
        getUserProvider: async () => providerDown(),
      })
      await app.ready()
      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/draft`,
        headers: { 'x-test-user': 'writer' },
      })
      expect(res.statusCode).toBe(502)
      const body = res.json() as { status: string; reason: string }
      expect(body.status).toBe('error')
      expect(body.reason).toContain('ECONNREFUSED')
      await app.close()
    },
  )
})
