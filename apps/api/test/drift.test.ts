import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { ForgejoProvider, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import { checkDrift } from '../src/indexer/drift.js'
import { indexSpace, type IndexReport } from '../src/indexer/index-space.js'
import type { AdminReindexResponse } from '../src/routes/admin.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const ADMIN_TOKEN = 'admin-test-token'

async function write(provider: ForgejoProvider, repo: RepoRef, path: string, content: string): Promise<void> {
  await provider.writeFile(repo, path, content, { branch: 'main', message: `seed: ${path}` })
}

/** Provider-Wrapper: delegiert alles an den echten Provider, außer `getHeadSha`,
 *  das immer einen (simulierten) Provider-Ausfall wirft — für den Fehler-
 *  Isolations-Test (ein Space schlägt fehl, andere laufen weiter). */
function providerWithBrokenHeadSha(inner: ForgejoProvider): GitProvider {
  return {
    readFile: (r, p, ref) => inner.readFile(r, p, ref),
    readFileBinary: (r, p, ref) => inner.readFileBinary(r, p, ref),
    listTree: (r, ref) => inner.listTree(r, ref),
    getHeadSha: async () => {
      throw new Error('simulated provider failure')
    },
    writeFile: (r, p, content, opts) => inner.writeFile(r, p, content, opts),
    writeFileBinary: (r, p, content, opts) => inner.writeFileBinary(r, p, content, opts),
    createBranch: (r, name, fromBranch) => inner.createBranch(r, name, fromBranch),
    deleteBranch: (r, name) => inner.deleteBranch(r, name),
    listCommits: (r, opts) => inner.listCommits(r, opts),
    createPullRequest: (r, opts) => inner.createPullRequest(r, opts),
    getPullRequest: (r, number) => inner.getPullRequest(r, number),
    mergePullRequest: (r, number) => inner.mergePullRequest(r, number),
  }
}

describe.sequential('Task 5: HEAD-Abgleich-Job + Admin-Reindex', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('drift')
    await write(provider, repo, 'index.md', `---\nid: home\ntitle: Start\nlang: de\n---\n# Start\n\nText.\n`)

    space = {
      id: 'drift-space',
      name: 'Drift',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    // Ausgangszustand: einmal vollständig indexiert, `indexedHeadSha` gesetzt.
    await indexSpace({ db, provider }, space)
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  describe('checkDrift', () => {
    it('kein Drift: HEAD unverändert → indexSpace wird nicht aufgerufen', async () => {
      const spy = vi.fn<(deps: unknown, s: SpaceConfig) => Promise<IndexReport>>()

      const results = await checkDrift(
        { db, providerRegistry: () => provider, indexSpace: spy as never },
        [space],
      )

      expect(spy).not.toHaveBeenCalled()
      expect(results).toEqual([{ spaceId: space.id, drifted: false }])
    })

    it(
      'Drift erkannt: extern committen → checkDrift indexiert (echter Reindex-Lauf, ' +
        'Spec-§11-Drehbuch „Drift-Heilung"/verpasster-Webhook-Semantik: der DIREKTE Provider-' +
        'Commit unten löst bewusst KEINEN Webhook aus — genau der Fall, den ein ausgefallener ' +
        'oder verpasster Webhook-Zustellversuch hinterlässt. `indexedHeadSha` bleibt bis zum ' +
        'nächsten `checkDrift`-Lauf auf dem alten Stand und wird erst durch die Heilung ' +
        'nachgezogen.)',
      async () => {
        // Vorher: DB-Stand ist der HEAD-Sha des Ausgangs-Commits (aus beforeAll,
        // vor dem gleich folgenden externen Commit).
        const beforeSpaceRow = (await db.select().from(spacesTable).where(eq(spacesTable.id, space.id)))[0]!
        const beforeIndexedHeadSha = beforeSpaceRow.indexedHeadSha
        expect(beforeIndexedHeadSha).toBeTruthy()
        expect(beforeIndexedHeadSha).toBe(await provider.getHeadSha(repo, 'main'))

        // Direkt via Provider/REST committen — OHNE Webhook (verpasster-Webhook-Simulation).
        await write(provider, repo, 'neu/index.md', `---\nid: neu\ntitle: Neu\nlang: de\n---\n# Neu\n\nText.\n`)
        const headShaAfterCommit = await provider.getHeadSha(repo, 'main')
        expect(headShaAfterCommit).not.toBe(beforeIndexedHeadSha)

        // Ohne Webhook UND ohne checkDrift bliebe die DB stehen: der Index kennt
        // den neuen Commit noch nicht — genau der Zustand, den ein verpasster
        // Webhook hinterlässt.
        const staleSpaceRow = (await db.select().from(spacesTable).where(eq(spacesTable.id, space.id)))[0]!
        expect(staleSpaceRow.indexedHeadSha).toBe(beforeIndexedHeadSha)
        const staleNeuRows = await db.select().from(pages).where(eq(pages.id, 'neu'))
        expect(staleNeuRows).toHaveLength(0)

        const results = await checkDrift({ db, providerRegistry: () => provider }, [space])

        expect(results).toHaveLength(1)
        expect(results[0]?.spaceId).toBe(space.id)
        expect(results[0]?.drifted).toBe(true)
        expect(results[0]?.report?.pagesIndexed).toBe(2)
        expect(results[0]?.report?.headSha).toBe(headShaAfterCommit)

        const neuRows = await db.select().from(pages).where(eq(pages.id, 'neu'))
        expect(neuRows).toHaveLength(1)

        // Nachher: Heilung nachgezogen — `indexedHeadSha` zeigt jetzt auf den
        // neuen HEAD, nicht mehr auf den alten (der verpasste Webhook ist
        // durch den Drift-Job kompensiert).
        const spaceRow = (await db.select().from(spacesTable).where(eq(spacesTable.id, space.id)))[0]!
        expect(spaceRow.indexedHeadSha).toBe(headShaAfterCommit)
        expect(spaceRow.indexedHeadSha).not.toBe(beforeIndexedHeadSha)
        expect(spaceRow.indexedHeadSha).toBe(results[0]?.report?.headSha)

        // Erneuter Lauf ohne weitere Änderung → kein Drift mehr.
        const second = await checkDrift({ db, providerRegistry: () => provider }, [space])
        expect(second[0]?.drifted).toBe(false)
      },
      60_000,
    )

    it('Fehler eines Space stoppt andere nicht: fehlerhafter Space wird geloggt, gesunder trotzdem indexiert', async () => {
      const brokenSpace: SpaceConfig = { ...space, id: 'broken-space' }
      const registry = (s: SpaceConfig): GitProvider =>
        s.id === brokenSpace.id ? providerWithBrokenHeadSha(provider) : provider

      await write(
        provider,
        repo,
        'weitere/index.md',
        `---\nid: weitere\ntitle: Weitere\nlang: de\n---\n# Weitere\n\nText.\n`,
      )

      const warnCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = []
      const logger = { warn: (msg: string, meta?: Record<string, unknown>) => warnCalls.push({ msg, meta }) }

      const results = await checkDrift({ db, providerRegistry: registry, logger }, [brokenSpace, space])

      const brokenResult = results.find((r) => r.spaceId === brokenSpace.id)!
      expect(brokenResult.drifted).toBe(false)
      expect(brokenResult.error).toBeDefined()
      expect(warnCalls.some((c) => c.meta?.spaceId === brokenSpace.id)).toBe(true)

      const healthyResult = results.find((r) => r.spaceId === space.id)!
      expect(healthyResult.drifted).toBe(true)
      expect(healthyResult.report?.pagesIndexed).toBe(3)

      const weitereRows = await db.select().from(pages).where(eq(pages.id, 'weitere'))
      expect(weitereRows).toHaveLength(1)
    }, 60_000)
  })

  describe('POST /admin/reindex', () => {
    it('ohne F451_ADMIN_TOKEN → 503 (Fail-Closed)', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        // kein adminToken gesetzt
      })
      const res = await app.inject({ method: 'POST', url: '/admin/reindex', payload: {} })
      expect(res.statusCode).toBe(503)
      await app.close()
    })

    it('falsches Token → 401', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/admin/reindex',
        headers: { authorization: 'Bearer falsches-token' },
        payload: {},
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('fehlender Authorization-Header → 401', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({ method: 'POST', url: '/admin/reindex', payload: {} })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('korrektes Token → voller Reindex, antwortet mit IndexReport', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/admin/reindex',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ space: string; report: IndexReport }>
      expect(body).toHaveLength(1)
      expect(body[0]?.space).toBe(space.id)
      expect(body[0]?.report.pagesIndexed).toBe(3)
      await app.close()
    }, 60_000)

    it('korrektes Token + space-Filter auf unbekannten Space → 404', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/admin/reindex',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { space: 'kein-space-hier' },
      })
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    it('Fehlerisolation: ein Space scheitert, ein anderer liefert trotzdem einen Report (200, Teilbericht)', async () => {
      const brokenSpace: SpaceConfig = { ...space, id: 'broken-admin-space' }
      const registry = (s: SpaceConfig): GitProvider =>
        s.id === brokenSpace.id ? providerWithBrokenHeadSha(provider) : provider

      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [brokenSpace, space],
        providerRegistry: registry,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/admin/reindex',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as AdminReindexResponse
      expect(body).toHaveLength(2)
      const brokenResult = body.find((r) => r.space === brokenSpace.id)!
      expect('error' in brokenResult).toBe(true)
      const healthyResult = body.find((r) => r.space === space.id)!
      expect('report' in healthyResult).toBe(true)
      await app.close()
    }, 60_000)

    it('alle angefragten Spaces scheitern → 502 mit Fehlerliste', async () => {
      const brokenSpace: SpaceConfig = { ...space, id: 'all-broken-space' }
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [brokenSpace],
        providerRegistry: () => providerWithBrokenHeadSha(provider),
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/admin/reindex',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: {},
      })
      expect(res.statusCode).toBe(502)
      const body = res.json() as AdminReindexResponse
      expect(body).toHaveLength(1)
      expect('error' in body[0]!).toBe(true)
      await app.close()
    }, 60_000)
  })

  describe('GET /admin/status (Task 5, Betrieb)', () => {
    it('ohne F451_ADMIN_TOKEN → 503 (exakt dasselbe Fail-Closed-Gate wie POST /admin/reindex)', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        // kein adminToken gesetzt
      })
      const res = await app.inject({ method: 'GET', url: '/admin/status' })
      expect(res.statusCode).toBe(503)
      await app.close()
    })

    it('falsches Token → 401', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { authorization: 'Bearer falsches-token' },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('fehlender Authorization-Header → 401', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({ method: 'GET', url: '/admin/status' })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('korrektes Token → 200 mit Zählerstand (frisch gebaute App: alle Zähler 0) und Uptime in Sekunden', async () => {
      const app = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => provider,
        adminToken: ADMIN_TOKEN,
      })
      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { counters: Record<string, unknown>; uptime: number }
      expect(body.counters).toEqual({
        webhookErrors: 0,
        indexerErrors: 0,
        driftErrors: 0,
        since: expect.any(String),
      })
      expect(typeof body.uptime).toBe('number')
      expect(body.uptime).toBeGreaterThanOrEqual(0)
      await app.close()
    })

    it(
      'admin/reindex mit einem gescheiterten Space erhöht anschließend indexerErrors in GET /admin/status ' +
        'NICHT automatisch (das zählt nur IO-Fehler beim Dateilesen, nicht Provider-Totalausfälle) — ' +
        'derselbe App-/Zähler-Instanz-Nachweis: beide Routen sehen dieselbe OpsCounters-Instanz',
      async () => {
        const brokenSpace: SpaceConfig = { ...space, id: 'status-broken-space' }
        const app = buildApp({
          databaseUrl: pg.connectionString,
          spaces: [brokenSpace],
          providerRegistry: () => providerWithBrokenHeadSha(provider),
          adminToken: ADMIN_TOKEN,
        })
        await app.inject({
          method: 'POST',
          url: '/admin/reindex',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
          payload: {},
        })

        const res = await app.inject({
          method: 'GET',
          url: '/admin/status',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json() as { counters: { indexerErrors: number } }
        // providerWithBrokenHeadSha wirft in getHeadSha, VOR jedem Dateilesen —
        // readPageFileSafe (der einzige indexerErrors-Inkrement-Ort) wird also
        // nie erreicht. Der Test dokumentiert diese Abgrenzung bewusst.
        expect(body.counters.indexerErrors).toBe(0)
        await app.close()
      },
      60_000,
    )
  })
})
