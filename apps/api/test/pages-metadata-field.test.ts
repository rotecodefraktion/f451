import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerPagesRoutes, type PagesDeps } from '../src/routes/pages.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Metadaten-Feature M1 (Backend-Fundament), Task 5: `GET /api/pages/:id`
 * reicht `PageFrontmatter.metadata` als eigenes `metadata`-Feld durch. Reiner
 * DB-Test (Muster `pages-routes.test.ts`): das Frontmatter-Objekt liegt schon
 * fertig geparst in der `frontmatter`-jsonb-Spalte (der Indexer schreibt es
 * 1:1, s. `indexer/index-space.ts`).
 *
 * Seit Feature M3b (Teil A, Auto-Feld-Ableitung) versucht die Route, das
 * Space-Schema über den GitProvider zu laden (`loadMetadataSchema`,
 * `spaces/metadata-schema.ts`) — DIESER Provider-Stub bleibt bewusst
 * "unreachable" (wirft bei jedem Aufruf): `loadMetadataSchema` fängt das
 * fail-soft ab (leeres Schema, s. dortiger Kommentar) und `metadata` bleibt
 * dadurch unverändert bei den rohen Frontmatter-Werten — genau das prüfen die
 * Fälle hier (kein Auto-Feld im Space-Schema konfiguriert → unverändertes
 * Verhalten wie vor M3b). Der End-zu-Ende-Fall MIT konfiguriertem
 * Auto-Feld/funktionierendem Schema-Provider ist `pages-metadata-auto.test.ts`.
 */
describe.sequential('GET /api/pages/:id: metadata-Feld (Metadaten-Feature M1, Task 5)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'meta-field-space',
    name: 'Meta Field Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  function buildTestApp(deps: PagesDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    registerPagesRoutes(app, deps)
    return app
  }

  const unreachableProvider = () => {
    const fail = (): never => {
      throw new Error('GitProvider darf von GET /api/pages/:id nicht aufgerufen werden.')
    }
    return {
      readFile: fail, readFileBinary: fail, listTree: fail, getHeadSha: fail, writeFile: fail,
      writeFileBinary: fail, createBranch: fail, deleteBranch: fail, listCommits: fail,
      createPullRequest: fail, getPullRequest: fail, listPullRequests: fail,
      requestReviewers: fail, submitPullRequestReview: fail, mergePullRequest: fail,
    }
  }

  it('gibt die Frontmatter-Metadaten einer Seite als eigenes metadata-Feld zurück', async () => {
    await db.insert(pages).values({
      id: 'sap-prozess', spaceId: space.id, path: 'sap/prozess/index.md', ref: 'main',
      title: 'SAP-Prozess', lang: 'de', htmlRendered: '<h1>SAP-Prozess</h1>',
      frontmatter: {
        tags: [], relations: {},
        metadata: { process_id: 'SAP-P-0042', business_unit: 'Einkauf', approved_by: 'jdoe' },
      },
    })

    const app = buildTestApp({ db, spaces: [space], providerRegistry: unreachableProvider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/sap-prozess' })
    expect(res.statusCode).toBe(200)
    expect(res.json().metadata).toEqual({
      process_id: 'SAP-P-0042', business_unit: 'Einkauf', approved_by: 'jdoe',
    })
    await app.close()
  })

  it('Seite ohne Metadaten → metadata ist ein leeres Objekt (kein undefined/null im Response)', async () => {
    await db.insert(pages).values({
      id: 'ohne-metadaten', spaceId: space.id, path: 'ohne-metadaten/index.md', ref: 'main',
      title: 'Ohne Metadaten', lang: 'de', htmlRendered: '<h1>Ohne Metadaten</h1>',
      frontmatter: { tags: [], relations: {} },
    })

    const app = buildTestApp({ db, spaces: [space], providerRegistry: unreachableProvider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/pages/ohne-metadaten' })
    expect(res.statusCode).toBe(200)
    expect(res.json().metadata).toEqual({})
    await app.close()
  })
})
