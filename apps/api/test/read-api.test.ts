import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { seedFixtureSpace, write } from './helpers/seed-space.js'

/** Provider-Wrapper: delegiert alles an den echten Provider, außer `readFile`,
 *  das immer wirft — simuliert einen Provider-Ausfall für den 502-Test. */
function providerWithBrokenReadFile(inner: GitProvider): GitProvider {
  return {
    readFile: async () => {
      throw new Error('simulated provider outage')
    },
    readFileBinary: (r, p, ref) => inner.readFileBinary(r, p, ref),
    listTree: (r, ref) => inner.listTree(r, ref),
    getHeadSha: (r, branch) => inner.getHeadSha(r, branch),
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

describe.sequential('Lese-API: Tree, Page, Raw, Suche', () => {
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
    repo = await forgejo.createRepo('read-api')
    await seedFixtureSpace(provider, repo)

    space = {
      id: 'betrieb',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    await indexSpace({ db, provider }, space)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
    })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  describe('GET /api/spaces', () => {
    it('liefert konfigurierte Spaces aus der Config, nicht aus der DB', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([{ id: 'betrieb', name: 'Betrieb', defaultLang: 'de' }])
    })
  })

  describe('GET /api/spaces/:space/tree', () => {
    it('liefert einen verschachtelten, alphabetisch sortierten Baum aus den Pages', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/tree' })
      expect(res.statusCode).toBe(200)
      const tree = res.json() as Array<{
        id: string
        title: string
        path: string
        archived: boolean
        hasChildren: boolean
        children: unknown[]
      }>

      // Wurzel: nur die Startseite (index.md) hat keine Hierarchie-Elternseite.
      expect(tree).toHaveLength(1)
      expect(tree[0]?.id).toBe('home')
      expect(tree[0]?.path).toBe('index.md')
      expect(tree[0]?.hasChildren).toBe(true)
      expect(tree[0]?.children).toHaveLength(1)

      const betriebNode = tree[0]?.children[0] as (typeof tree)[number]
      expect(betriebNode.id).toBe('betrieb')
      expect(betriebNode.hasChildren).toBe(true)

      // Kinder von 'betrieb': deployment, monitoring, broken-yaml, archiviert — alphabetisch nach Titel sortiert.
      const childTitles = betriebNode.children.map((c) => (c as { title: string }).title)
      const sortedTitles = [...childTitles].sort((a, b) => a.localeCompare(b))
      expect(childTitles).toEqual(sortedTitles)
      expect(betriebNode.children).toHaveLength(4)

      const deploymentNode = betriebNode.children.find(
        (c) => (c as { id: string }).id === 'deployment',
      ) as { hasChildren: boolean; archived: boolean } | undefined
      expect(deploymentNode?.hasChildren).toBe(false)
      expect(deploymentNode?.archived).toBe(false)
    })

    it('archivierte Seiten werden NICHT aus dem Baum gefiltert, sondern mit archived=true markiert', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/tree' })
      expect(res.statusCode).toBe(200)
      const tree = res.json() as Array<{ id: string; children: unknown[] }>
      const betriebNode = tree[0]?.children[0] as { children: Array<{ id: string; archived: boolean }> }

      const archivedNode = betriebNode.children.find((c) => c.id === 'archiviert')
      expect(archivedNode).toBeDefined()
      expect(archivedNode?.archived).toBe(true)
    })

    it('unbekannter Space → 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/nicht-konfiguriert/tree' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /api/pages/:id', () => {
    it('liefert HTML, Broken-Links, Headings, Tags und Relations', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/home' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.id).toBe('home')
      expect(body.space).toBe('betrieb')
      expect(body.path).toBe('index.md')
      expect(body.title).toBe('Startseite')
      expect(body.html).toContain('/wiki/betrieb/deployment')
      expect(body.html).toContain('broken-link')
      expect(body.tags).toEqual(['start'])
      expect(body.archived).toBe(false)
      expect(body.brokenLinks).toEqual(['gibt-es-nicht'])
      expect(body.frontmatterErrors).toEqual([])
      expect(body.errorStatus).toBeNull()
      expect(Array.isArray(body.headings)).toBe(true)
      expect(typeof body.updatedAt).toBe('string')

      const betriebRes = await app.inject({ method: 'GET', url: '/api/pages/betrieb' })
      const betriebBody = betriebRes.json()
      expect(betriebBody.relations).toEqual({ depends_on: ['deployment'] })
    })

    it('unbekannte Seite → 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/nicht-vorhanden' })
      expect(res.statusCode).toBe(404)
    })

    it('Seite mit kaputtem YAML → errorStatus=parse_error, Frontmatter-Fehler + HTML trotzdem vorhanden', async () => {
      const brokenId = 'path:betrieb/betrieb/broken-yaml/index.md'
      const res = await app.inject({ method: 'GET', url: `/api/pages/${encodeURIComponent(brokenId)}` })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.id).toBe(brokenId)
      expect(body.errorStatus).toBe('parse_error')
      expect(body.frontmatterErrors.length).toBeGreaterThan(0)
      expect(typeof body.html).toBe('string')
      expect(body.html.length).toBeGreaterThan(0)
    })
  })

  describe('GET /api/pages/:id/raw', () => {
    it('liefert Markdown frisch vom Provider, byte-gleich mit dem Repo-Inhalt', async () => {
      const expected = (await provider.readFile(repo, 'betrieb/deployment/index.md', 'main')).content
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/raw' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/markdown')
      expect(res.body).toBe(expected)
    })

    it('unbekannte Seite → 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/nicht-vorhanden/raw' })
      expect(res.statusCode).toBe(404)
    })

    it('ohne ?download bleibt Content-Disposition weiterhin unverändert unbelegt (Interop-Endpunkt)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/raw' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-disposition']).toBeUndefined()
    })

    it('?download=1 setzt Content-Disposition: attachment mit Dateiname aus dem Seitenverzeichnis', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/deployment/raw?download=1' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-disposition']).toBe('attachment; filename="deployment.md"')
      expect(res.headers['content-type']).toContain('text/markdown')
    })

    it('?download=1 auf der Space-Wurzel (index.md, kein Verzeichnis) → filename="index.md"', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/home/raw?download=1' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-disposition']).toBe('attachment; filename="index.md"')
    })

    it('Provider-Fehler beim Lesen → 502 mit Meldung', async () => {
      const failingApp = buildApp({
        databaseUrl: pg.connectionString,
        spaces: [space],
        providerRegistry: () => providerWithBrokenReadFile(provider),
      })
      const res = await failingApp.inject({ method: 'GET', url: '/api/pages/deployment/raw' })
      expect(res.statusCode).toBe(502)
      expect(res.json().reason).toContain('simulated provider outage')
      await failingApp.close()
    })
  })

  describe('GET /api/search', () => {
    it('findet gestemmt (de): "Deployments" → die "Deployment"-Seite', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=Deployments' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{
        id: string
        title: string
        space: string
        rank: number
        snippet: string
        path: string
      }>
      const hit = body.find((r) => r.id === 'deployment')
      expect(hit).toBeDefined()
      expect(hit?.title).toBe('Deployment')
      expect(hit?.space).toBe('betrieb')
      expect(typeof hit?.rank).toBe('number')
      expect(typeof hit?.snippet).toBe('string')
      // Phase 2c: Treffer tragen zusätzlich den `index.md`-Pfad — das
      // `[[`-Autocomplete im Editor braucht ihn als eindeutiges Wikilink-Target.
      expect(hit?.path).toBe('betrieb/deployment/index.md')
    })

    it('findet exakt über den simple-Vektor', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=observability' })
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'monitoring')).toBe(true)
    })

    it('filtert nach space und tag', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=Betrieb&tag=wichtig' })
      const body = res.json() as Array<{ id: string }>
      expect(body.length).toBeGreaterThan(0)
      expect(body.every((r) => r.id === 'betrieb')).toBe(true)
    })

    it('filtert nach space (kein Treffer in fremdem Space)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=Betrieb&space=anderer-space' })
      expect(res.json()).toEqual([])
    })

    it('leere Query → leeres Ergebnis', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })

    it('archivierte Seiten werden nicht aus der Suche gefiltert', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=Archivinhalt' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'archiviert')).toBe(true)
    })

    // --- Phase 3a Task 1: english-Zweig + Präfix-Suche ---

    it('findet gestemmt (en): "observable" → die englischsprachige Monitoring-Seite', async () => {
      // Der Vektor der en-Seite ist english-gestemmt ('observability' → 'observ').
      // 'observable' stemmt english ebenfalls zu 'observ', german und simple
      // matchen nicht → der Test beweist den english-Zweig der Suchroute.
      const res = await app.inject({ method: 'GET', url: '/api/search?q=observable' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'monitoring')).toBe(true)
    })

    it('prefix=true: unvollständiges letztes Wort matcht („Deplo" → Deployment)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=Deplo&prefix=true' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'deployment')).toBe(true)
    })

    it('ohne prefix bleibt „Deplo" ohne Treffer (Bestandsverhalten unverändert)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=Deplo' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'deployment')).toBe(false)
    })

    it('prefix=true: bei mehreren Worten ist nur das letzte Präfix', async () => {
      // 'details' steht wörtlich im simple-Anteil des Deployment-Vektors,
      // 'deplo' matcht nur als Präfix.
      const res = await app.inject({ method: 'GET', url: '/api/search?q=details%20deplo&prefix=true' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'deployment')).toBe(true)
    })

    it('prefix=true: tsquery-Syntaxzeichen in der Eingabe sind harmlos (kein 500)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/search?q=${encodeURIComponent('Deplo)(&|!:*')}&prefix=true`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((r) => r.id === 'deployment')).toBe(true)
    })

    it('prefix=true: Eingabe ohne verwertbare Zeichen → leeres Ergebnis, kein Fehler', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/search?q=${encodeURIComponent('&&& (((')}&prefix=true`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })
  })

  describe('GET /api/spaces/:space/broken-links', () => {
    it('listet Seiten mit nicht auflösbaren Verweisen, pro Seite gruppiert', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/betrieb/broken-links' })
      expect(res.statusCode).toBe(200)
      // Fixture: nur die Startseite hat einen kaputten Verweis ([[gibt-es-nicht]]).
      // [[Monitoring]] (Titel-Match), der relative Link und die depends_on-Relation
      // lösen alle auf — sie dürfen NICHT im Report erscheinen.
      expect(res.json()).toEqual([
        {
          pageId: 'home',
          title: 'Startseite',
          path: 'index.md',
          entries: [{ rawTarget: 'gibt-es-nicht', type: 'link', label: '' }],
        },
      ])
    })

    it('unbekannter Space → 404 (kein Existenz-Orakel)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/gibt-es-nicht/broken-links' })
      expect(res.statusCode).toBe(404)
      expect(res.json().status).toBe('not_found')
    })
  })
})

describe.sequential('GET /api/spaces/:space/tree: Geschwister-Sortierung nach orderKey (Phase 3.3)', () => {
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
    repo = await forgejo.createRepo('read-api-order')

    await write(provider, repo, 'index.md', '---\nid: home\ntitle: Startseite\nlang: de\n---\n# Startseite\n')
    await write(provider, repo, 'betrieb/index.md', '---\nid: betrieb\ntitle: Betrieb\nlang: de\n---\n# Betrieb\n')
    await write(provider, repo, 'betrieb/alpha/index.md', '---\nid: alpha\ntitle: Alpha\nlang: de\n---\n# Alpha\n')
    await write(provider, repo, 'betrieb/beta/index.md', '---\nid: beta\ntitle: Beta\nlang: de\n---\n# Beta\n')
    await write(provider, repo, 'betrieb/gamma/index.md', '---\nid: gamma\ntitle: Gamma\nlang: de\n---\n# Gamma\n')
    // Gewünschte Reihenfolge: gamma vor alpha — `beta` bleibt UNGELISTET.
    await write(provider, repo, 'betrieb/.order', 'gamma\nalpha\n')

    space = {
      id: 'order-tree',
      name: 'Order-Tree',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    await indexSpace({ db, provider }, space)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
    })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it(
    'sortiert Geschwister primär nach orderKey (aus `.order`) — Kinder OHNE Eintrag ' +
      '(hier: beta) landen NACH allen geordneten Geschwistern, alphabetisch nach Titel',
    async () => {
      const res = await app.inject({ method: 'GET', url: '/api/spaces/order-tree/tree' })
      expect(res.statusCode).toBe(200)
      const tree = res.json() as Array<{ id: string; children: Array<{ id: string }> }>

      const betriebNode = tree[0]?.children[0] as { children: Array<{ id: string }> }
      expect(betriebNode.children.map((c) => c.id)).toEqual(['gamma', 'alpha', 'beta'])
    },
  )
})
