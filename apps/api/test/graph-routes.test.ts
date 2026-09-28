import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { seedFixtureSpace } from './helpers/seed-space.js'

interface GraphResponse {
  nodes: Array<{ id: string; title: string; path: string; status: string; tags: string[]; updatedAt: string }>
  edges: Array<{ from: string; to: string; type: string; label: string }>
}

describe.sequential('Graph-API', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('graph-api')
    await seedFixtureSpace(provider, repo)
    space = { id: 'betrieb', name: 'Betrieb', provider: 'forgejo', owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo }
    await indexSpace({ db, provider }, space)
    app = buildApp({ databaseUrl: pg.connectionString, spaces: [space], providerRegistry: () => provider })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  describe('GET /api/spaces/:space/graph', () => {
    it('liefert Knoten aller main-Seiten und Kanten der Default-Typen (ohne tag, ohne Broken Links)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/graph' })
      expect(res.statusCode).toBe(200)
      const g = res.json() as GraphResponse
      // Fixture: home, betrieb, deployment, monitoring, archiviert + broken-yaml (Fallback-Id).
      expect(g.nodes.length).toBeGreaterThanOrEqual(5)
      const ids = g.nodes.map((n) => n.id)
      expect(ids).toEqual(expect.arrayContaining(['home', 'betrieb', 'deployment', 'monitoring', 'archiviert']))
      // Ohne Auth (kein access): Status nur Index-Wissen.
      expect(g.nodes.find((n) => n.id === 'archiviert')?.status).toBe('archived')
      expect(g.nodes.find((n) => n.id === 'deployment')?.status).toBe('released')
      // Kein tag-Typ per Default; Broken Link ([[gibt-es-nicht]]) nie als Kante.
      expect(g.edges.every((e) => e.type !== 'tag')).toBe(true)
      expect(g.edges.every((e) => e.to !== null)).toBe(true)
      // Die depends_on-Relation aus betrieb/index.md ist da:
      expect(g.edges).toEqual(expect.arrayContaining([{ from: 'betrieb', to: 'deployment', type: 'relation', label: 'depends_on' }]))
      // Hierarchie: deployment hängt unter betrieb.
      expect(g.edges).toEqual(expect.arrayContaining([{ from: 'deployment', to: 'betrieb', type: 'hierarchy', label: '' }]))
    })

    it('types=tag liefert zur Abfragezeit berechnete Tag-Kanten (ops verbindet deployment/monitoring/archiviert)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/graph?types=tag' })
      expect(res.statusCode).toBe(200)
      const g = res.json() as GraphResponse
      expect(g.edges.length).toBeGreaterThanOrEqual(3)
      expect(g.edges.every((e) => e.type === 'tag' && e.label.length > 0)).toBe(true)
      expect(g.edges).toEqual(expect.arrayContaining([{ from: 'archiviert', to: 'deployment', type: 'tag', label: 'ops' }]))
    })

    it('unbekannter types-Wert → 400 mit Begründung', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/graph?types=link,unsinn' })
      expect(res.statusCode).toBe(400)
      expect(res.json().reason).toContain('unsinn')
    })

    it('doppelter types-Parameter (?types=link&types=tag) → 400 im Projekt-Fehlerformat, nicht 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/graph?types=link&types=tag' })
      expect(res.statusCode).toBe(400)
      expect(res.json().status).toBe('bad_request')
    })

    it('unbekannter Space → 404 (kein Existenz-Orakel)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/gibt-es-nicht/graph' })
      expect(res.statusCode).toBe(404)
      expect(res.json().status).toBe('not_found')
    })
  })

  describe('GET /api/pages/:id/graph', () => {
    it('depth=1 liefert Zentrum + direkte Nachbarn inkl. eingehender Kanten', async () => {
      // deployment: Hierarchie-Kind von betrieb, eingehende relation von betrieb,
      // eingehender Wikilink von home — home und betrieb sind Nachbarn.
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph?depth=1' })
      expect(res.statusCode).toBe(200)
      const g = res.json() as GraphResponse
      const ids = g.nodes.map((n) => n.id)
      expect(ids).toContain('deployment')
      expect(ids).toEqual(expect.arrayContaining(['home', 'betrieb', 'monitoring']))
      expect(g.edges.every((e) => ids.includes(e.from) && ids.includes(e.to))).toBe(true)
    })

    it('Default-Tiefe ist 2; depth außerhalb 1..4 → 400', async () => {
      const ok = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph' })
      expect(ok.statusCode).toBe(200)
      const bad = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph?depth=9' })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().status).toBe('bad_request')
    })

    it('depth=abc (nicht-koerzierbar) → 400 im Projekt-Fehlerformat, nicht 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph?depth=abc' })
      expect(res.statusCode).toBe(400)
      expect(res.json().status).toBe('bad_request')
    })

    it('depth=1.5 (kein Integer) → 400 im Projekt-Fehlerformat, nicht 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph?depth=1.5' })
      expect(res.statusCode).toBe(400)
      expect(res.json().status).toBe('bad_request')
    })

    it('doppelter depth-Parameter (?depth=1&depth=2) → 400 im Projekt-Fehlerformat, nicht 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph?depth=1&depth=2' })
      expect(res.statusCode).toBe(400)
      expect(res.json().status).toBe('bad_request')
    })

    it('doppelter types-Parameter (?types=link&types=tag) → 400 im Projekt-Fehlerformat, nicht 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/graph?types=link&types=tag' })
      expect(res.statusCode).toBe(400)
      expect(res.json().status).toBe('bad_request')
    })

    it('unbekannte Seite → 404 (kein Existenz-Orakel)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/gibt-es-nicht/graph' })
      expect(res.statusCode).toBe(404)
    })
  })
})
