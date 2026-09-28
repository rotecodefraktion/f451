import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import {
  canReadSpace,
  canWriteSpace,
  clearPermissionCache,
  invalidateUserPermissions,
  type PermissionDeps,
} from '../src/auth/permissions.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Legt eine Seite direkt (ohne Git-Provider) an — für Regressionstests, die
 * gezielte Ranking-Verhältnisse brauchen (viele hochrangige vs. einen
 * niedrigrangigen Treffer), ohne Dutzende Repo-Dateien über Forgejo zu seeden.
 */
async function insertRankedPage(
  db: Db,
  args: { id: string; spaceId: string; title: string; plainText: string; weight: 'A' | 'D' },
): Promise<void> {
  await db.insert(pages).values({
    id: args.id,
    spaceId: args.spaceId,
    path: `${args.id}.md`,
    ref: 'main',
    title: args.title,
    plainText: args.plainText,
    lang: 'de',
    updatedAt: new Date(),
  })
  await db.execute(sql`
    update pages set search_vector =
      setweight(to_tsvector('german'::regconfig, ${args.title} || ' ' || ${args.plainText}), ${args.weight}::"char")
    where id = ${args.id}
  `)
}

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

/** Seedet ein Space-Repo mit einer Startseite und einem gemeinsamen Suchbegriff. */
async function seed(provider: ForgejoProvider, repo: RepoRef, pageId: string, marker: string): Promise<void> {
  await provider.writeFile(
    repo,
    'index.md',
    `---\nid: ${pageId}\ntitle: ${pageId} Start\nlang: de\n---\n# ${pageId}\n\n${marker} Inhalt der Seite.\n`,
    { branch: 'main', message: 'seed' },
  )
}

describe.sequential('Berechtigungs-Vererbung von der Git-Plattform (Task 5)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider

  let spaceA: SpaceConfig // öffentlich → für den Reader lesbar
  let spaceB: SpaceConfig // privat, fremd → für den Reader NICHT lesbar

  let reader: ForgejoTestUser
  const readerUserId = 'perm-reader'
  const noAccountUserId = 'perm-no-account'
  // Für canWriteSpace (Phase 2a Task 1): ownerUserId ist mit dem Admin-Token
  // verknüpft (Repo-Eigentümer von spaceA/spaceB, hat also Push-Recht).
  // readerUserId wird zusätzlich als Collaborator MIT NUR Leserecht auf
  // spaceA eingetragen (Forgejo PUT .../collaborators/{user} {permission:'read'})
  // — canRead bleibt true (Repo ist ohnehin öffentlich), canWrite muss false sein.
  const ownerUserId = 'perm-owner'

  let permDeps: PermissionDeps

  // App MIT Auth (Schutz + Filterung) und eine zweite OHNE Auth (alles offen).
  let appAuth: FastifyInstance
  let appOpen: FastifyInstance

  let readerSession: string
  let noAccountSession: string
  let ownerSession: string

  // Gemeinsamer Suchbegriff, der in beiden Spaces vorkommt — nur der zugängliche
  // Space darf in der Suche auftauchen.
  const MARKER = 'geheimwissensuchbegriff'

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })

    const repoA = await forgejo.createRepo('space-a-public', { private: false })
    const repoB = await forgejo.createRepo('space-b-private', { private: true })
    await seed(provider, repoA, 'a-home', MARKER)
    await seed(provider, repoB, 'b-home', MARKER)

    spaceA = {
      id: 'space-a', name: 'Space A', provider: 'forgejo',
      owner: repoA.owner, repo: repoA.repo, defaultLang: 'de', repoRef: repoA,
    }
    spaceB = {
      id: 'space-b', name: 'Space B', provider: 'forgejo',
      owner: repoB.owner, repo: repoB.repo, defaultLang: 'de', repoRef: repoB,
    }

    // Beide Spaces werden vom Service-Account (Admin) indexiert — die Nutzer-
    // Sichtbarkeit ist davon unabhängig (Provider-Probe mit Nutzer-Token).
    await indexSpace({ db, provider }, spaceA)
    await indexSpace({ db, provider }, spaceB)

    // Zweiter Nutzer im Container + verknüpftes (verschlüsseltes) Token.
    reader = await forgejo.createUser('reader')
    await db.insert(users).values([
      { id: readerUserId, email: 'reader@example.org', displayName: 'Reader' },
      { id: noAccountUserId, email: 'noacc@example.org', displayName: 'No Account' },
      { id: ownerUserId, email: 'owner@example.org', displayName: 'Owner' },
    ])
    await upsertProviderAccount(
      db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY,
    )
    // ownerUserId nutzt dasselbe Token wie der Admin/Repo-Eigentümer von
    // spaceA/spaceB — für den canWriteSpace-Test „Owner-Token → canWrite true".
    await upsertProviderAccount(
      db, ownerUserId, 'forgejo', 'contract-admin', { accessToken: forgejo.token }, TOKEN_KEY,
    )
    // reader als Collaborator MIT NUR Leserecht auf spaceA (Forgejo-API) — echte
    // Antwortform der Repo-Probe für einen expliziten Read-Collaborator prüfen.
    await forgejo.addCollaborator(spaceA.repoRef, reader.username, 'read')

    permDeps = { db, tokenKey: TOKEN_KEY, forgejoBaseUrl: forgejo.baseUrl }

    appAuth = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [spaceA, spaceB],
      providerRegistry: () => provider,
      // Wie die Service-Account-Registry, unabhängig von `auth.connect.forgejo`
      // (Phase 2a Task 2, Konsistenz-Auflage aus dem Task-1-Review).
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: {
          forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' },
        },
      },
    })
    await appAuth.ready()

    appOpen = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [spaceA, spaceB],
      providerRegistry: () => provider,
    })
    await appOpen.ready()

    readerSession = (await createSession(db, readerUserId)).id
    noAccountSession = (await createSession(db, noAccountUserId)).id
    ownerSession = (await createSession(db, ownerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await appAuth?.close()
    await appOpen?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  beforeEach(() => {
    // Modul-globaler Cache zwischen Fällen leeren, damit Cache-Zählungen und
    // Filterung deterministisch sind.
    clearPermissionCache()
  })

  describe('canReadSpace', () => {
    it('true für den zugänglichen Space A, false für den privaten fremden Space B', async () => {
      expect(await canReadSpace(permDeps, readerUserId, spaceA)).toBe(true)
      expect(await canReadSpace(permDeps, readerUserId, spaceB)).toBe(false)
    })

    it('false, wenn der Nutzer kein verknüpftes Konto hat (keine Probe möglich)', async () => {
      expect(await canReadSpace(permDeps, noAccountUserId, spaceA)).toBe(false)
    })

    it('Cache-Treffer: der zweite Aufruf löst keine Provider-Probe aus', async () => {
      let calls = 0
      const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1
        return fetch(url, init)
      }
      const deps: PermissionDeps = { ...permDeps, fetch: countingFetch }

      expect(await canReadSpace(deps, readerUserId, spaceA)).toBe(true)
      expect(calls).toBe(1)
      // Zweiter Aufruf: aus dem Cache, kein weiterer Provider-Fetch.
      expect(await canReadSpace(deps, readerUserId, spaceA)).toBe(true)
      expect(calls).toBe(1)
    })

    it('invalidateUserPermissions erzwingt eine erneute Probe', async () => {
      let calls = 0
      const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1
        return fetch(url, init)
      }
      const deps: PermissionDeps = { ...permDeps, fetch: countingFetch }

      await canReadSpace(deps, readerUserId, spaceA)
      expect(calls).toBe(1)
      invalidateUserPermissions(readerUserId)
      await canReadSpace(deps, readerUserId, spaceA)
      expect(calls).toBe(2)
    })

    it('respektiert die TTL: nach Ablauf wird erneut geprobt', async () => {
      let calls = 0
      const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1
        return fetch(url, init)
      }
      let clock = 1_000
      const deps: PermissionDeps = { ...permDeps, fetch: countingFetch, now: () => clock }

      await canReadSpace(deps, readerUserId, spaceA)
      expect(calls).toBe(1)
      clock += 5 * 60 * 1000 + 1 // TTL überschritten
      await canReadSpace(deps, readerUserId, spaceA)
      expect(calls).toBe(2)
    })

    it('Cache-Key kollidiert nicht bei ":" in Ids (userId "a"+spaceId "b:c" vs. userId "a:b"+spaceId "c")', async () => {
      // Naive String-Verkettung `${userId}:${spaceId}` ergäbe für beide Paare
      // denselben Schlüssel "a:b:c". Mit dem JSON-Tupel-Key müssen sie getrennt
      // bleiben — belegt mit bewusst unterschiedlichen Werten (true vs. false),
      // damit eine Kollision sofort sichtbar würde.
      const collisionUserId = 'a'
      await db.insert(users).values({ id: collisionUserId, email: 'a@example.org', displayName: 'A' })
      await upsertProviderAccount(
        db, collisionUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY,
      )

      const spaceBC: SpaceConfig = { ...spaceA, id: 'b:c' } // userId 'a' hat Zugriff → true
      const spaceC: SpaceConfig = { ...spaceA, id: 'c' } // userId 'a:b' hat kein Konto → false

      expect(await canReadSpace(permDeps, collisionUserId, spaceBC)).toBe(true)
      expect(await canReadSpace(permDeps, 'a:b', spaceC)).toBe(false)
      // Kollisionsprobe: der zweite (false-)Schreibvorgang darf den ersten
      // (true-)Eintrag nicht überschrieben haben.
      expect(await canReadSpace(permDeps, collisionUserId, spaceBC)).toBe(true)

      // invalidateUserPermissions('a:b') darf den Eintrag von userId 'a' nicht
      // mit-löschen — verifiziert über: kein erneuter Provider-Fetch nötig.
      let calls = 0
      const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1
        return fetch(url, init)
      }
      const deps: PermissionDeps = { ...permDeps, fetch: countingFetch }
      invalidateUserPermissions('a:b')
      expect(await canReadSpace(deps, collisionUserId, spaceBC)).toBe(true)
      expect(calls).toBe(0)

      // invalidateUserPermissions('a') löscht dagegen genau diesen Eintrag.
      invalidateUserPermissions(collisionUserId)
      expect(await canReadSpace(deps, collisionUserId, spaceBC)).toBe(true)
      expect(calls).toBe(1)
    })
  })

  describe('canWriteSpace (Phase 2a Task 1)', () => {
    it('Owner-Token → canWrite true', async () => {
      expect(await canWriteSpace(permDeps, ownerUserId, spaceA)).toBe(true)
    })

    it('Nur-Lese-Collaborator → canRead true, canWrite false', async () => {
      expect(await canReadSpace(permDeps, readerUserId, spaceA)).toBe(true)
      expect(await canWriteSpace(permDeps, readerUserId, spaceA)).toBe(false)
    })

    it('false, wenn der Nutzer kein verknüpftes Konto hat (keine Probe möglich)', async () => {
      expect(await canWriteSpace(permDeps, noAccountUserId, spaceA)).toBe(false)
    })

    it('Cache-Treffer: der zweite Aufruf löst keine Provider-Probe aus (eigener Namespace)', async () => {
      let calls = 0
      const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1
        return fetch(url, init)
      }
      const deps: PermissionDeps = { ...permDeps, fetch: countingFetch }

      expect(await canWriteSpace(deps, ownerUserId, spaceA)).toBe(true)
      expect(calls).toBe(1)
      expect(await canWriteSpace(deps, ownerUserId, spaceA)).toBe(true)
      expect(calls).toBe(1)
    })

    it('Lese- und Schreib-Cache sind unabhängig: ein Treffer im einen Namespace probt den anderen trotzdem', async () => {
      let calls = 0
      const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1
        return fetch(url, init)
      }
      const deps: PermissionDeps = { ...permDeps, fetch: countingFetch }

      expect(await canReadSpace(deps, ownerUserId, spaceA)).toBe(true)
      expect(calls).toBe(1)
      // canWriteSpace nutzt einen eigenen Cache-Key ('write'-Namespace) — der
      // Lese-Cache-Treffer darf hier KEINEN Schreib-Cache-Treffer vortäuschen.
      expect(await canWriteSpace(deps, ownerUserId, spaceA)).toBe(true)
      expect(calls).toBe(2)
    })

    it(
      'invalidateUserPermissions erfasst BEIDE Namespaces (Lesen und Schreiben)',
      async () => {
        let calls = 0
        const countingFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
          calls += 1
          return fetch(url, init)
        }
        const deps: PermissionDeps = { ...permDeps, fetch: countingFetch }

        await canReadSpace(deps, ownerUserId, spaceA)
        await canWriteSpace(deps, ownerUserId, spaceA)
        expect(calls).toBe(2)

        // Beide Ergebnisse sind jetzt gecacht — ohne Invalidierung würden die
        // nächsten beiden Aufrufe aus dem Cache bedient (calls bliebe 2).
        invalidateUserPermissions(ownerUserId)

        await canReadSpace(deps, ownerUserId, spaceA)
        await canWriteSpace(deps, ownerUserId, spaceA)
        expect(calls).toBe(4)
      },
    )
  })

  describe('canWriteSpace (GitHub, Phase 2a Task 2 — Review-Auflage A: bislang fehlende Testabdeckung)', () => {
    // Bislang (Task 1) nur gegen den echten Forgejo-Container geprüft — für
    // GitHub fehlte eine eigene Probe. Muster wie `auth-connect.test.ts`:
    // undici MockAgent für `api.github.com`, kein `disableNetConnect` (das
    // reale Netzwerk bleibt für den Forgejo-Container in anderen Tests offen).
    const githubUserId = 'perm-github-writer'
    const githubSpace: SpaceConfig = {
      id: 'space-github', name: 'GitHub Space', provider: 'github',
      owner: 'octo-org', repo: 'octo-repo', defaultLang: 'de',
      repoRef: { provider: 'github', owner: 'octo-org', repo: 'octo-repo' },
    }

    let agent: MockAgent
    let prevDispatcher: Dispatcher

    beforeAll(async () => {
      await db.insert(users).values({ id: githubUserId, email: 'gh-writer@example.org', displayName: 'GH Writer' })
      await upsertProviderAccount(db, githubUserId, 'github', 'gh-writer', { accessToken: 'gh-writer-token' }, TOKEN_KEY)
    })

    beforeEach(() => {
      prevDispatcher = getGlobalDispatcher()
      agent = new MockAgent()
      setGlobalDispatcher(agent)
    })

    afterEach(async () => {
      setGlobalDispatcher(prevDispatcher)
      await agent.close()
    })

    function mockGithubRepo(push: boolean): void {
      agent
        .get('https://api.github.com')
        .intercept({ path: '/repos/octo-org/octo-repo', method: 'GET' })
        .reply(200, { permissions: { push } })
    }

    it('permissions.push=true im Repo-Body → canWrite true', async () => {
      mockGithubRepo(true)
      expect(await canWriteSpace(permDeps, githubUserId, githubSpace)).toBe(true)
    })

    it('permissions.push=false im Repo-Body → canWrite false', async () => {
      mockGithubRepo(false)
      expect(await canWriteSpace(permDeps, githubUserId, githubSpace)).toBe(false)
    })

    it('nicht-200-Antwort (z. B. 404, privates fremdes Repo) → canWrite false', async () => {
      agent
        .get('https://api.github.com')
        .intercept({ path: '/repos/octo-org/octo-repo', method: 'GET' })
        .reply(404, { message: 'Not Found' })
      expect(await canWriteSpace(permDeps, githubUserId, githubSpace)).toBe(false)
    })

    it('kein verknüpftes Konto → canWrite false (keine Probe möglich)', async () => {
      expect(await canWriteSpace(permDeps, noAccountUserId, githubSpace)).toBe(false)
    })
  })

  describe('Routen-Filterung mit Auth (Reader mit Zugriff nur auf Space A)', () => {
    const cookies = (): Record<string, string> => ({ [SESSION_COOKIE_NAME]: readerSession })

    it('GET /api/spaces liefert nur den zugänglichen Space', async () => {
      const res = await appAuth.inject({ method: 'GET', url: '/api/spaces', cookies: cookies() })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([{ id: 'space-a', name: 'Space A', defaultLang: 'de' }])
    })

    it('GET tree: Space A → 200, Space B → 404 (kein Existenz-Orakel)', async () => {
      const a = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-a/tree', cookies: cookies() })
      expect(a.statusCode).toBe(200)
      expect((a.json() as unknown[]).length).toBeGreaterThan(0)

      const b = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-b/tree', cookies: cookies() })
      expect(b.statusCode).toBe(404)
    })

    it('GET broken-links: Space A → 200, Space B → 404 (kein Existenz-Orakel)', async () => {
      const a = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-a/broken-links', cookies: cookies() })
      expect(a.statusCode).toBe(200)
      const b = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-b/broken-links', cookies: cookies() })
      expect(b.statusCode).toBe(404)
    })

    it('GET graph: Space A → 200, Space B → 404 (kein Existenz-Orakel)', async () => {
      const a = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-a/graph', cookies: cookies() })
      expect(a.statusCode).toBe(200)
      const b = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-b/graph', cookies: cookies() })
      expect(b.statusCode).toBe(404)
    })

    it('GET templates: Space A → 200, Space B → 404 (kein Existenz-Orakel)', async () => {
      const a = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-a/templates', cookies: cookies() })
      expect(a.statusCode).toBe(200)
      const b = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-b/templates', cookies: cookies() })
      expect(b.statusCode).toBe(404)
    })

    it('GET page/raw: Seite aus Space A → 200, Seite aus Space B → 404', async () => {
      const pa = await appAuth.inject({ method: 'GET', url: '/api/pages/a-home', cookies: cookies() })
      expect(pa.statusCode).toBe(200)
      const ra = await appAuth.inject({ method: 'GET', url: '/api/pages/a-home/raw', cookies: cookies() })
      expect(ra.statusCode).toBe(200)

      const pb = await appAuth.inject({ method: 'GET', url: '/api/pages/b-home', cookies: cookies() })
      expect(pb.statusCode).toBe(404)
      const rb = await appAuth.inject({ method: 'GET', url: '/api/pages/b-home/raw', cookies: cookies() })
      expect(rb.statusCode).toBe(404)
    })

    it('GET /api/search liefert nur Treffer aus zugänglichen Spaces', async () => {
      const res = await appAuth.inject({
        method: 'GET', url: `/api/search?q=${MARKER}`, cookies: cookies(),
      })
      expect(res.statusCode).toBe(200)
      const rows = res.json() as Array<{ id: string; space: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.space === 'space-a')).toBe(true)
      expect(rows.some((r) => r.space === 'space-b')).toBe(false)
    })

    it('GET /api/search mit Zugriff auf ≥2 Spaces liefert Treffer statt 500 (Regressionstest doppelt geklammerte IN-Liste)', async () => {
      // Bug: `sql`p.space_id in (${allowedSpaceIds})`` klammert die von Drizzle
      // bereits geklammerte Parameterliste ein zweites Mal → Postgres liest
      // `in (($1,$2))` als Row-Konstruktor-Vergleich ("operator does not
      // exist: text = record") statt als Werteliste. Der Reader hat nur
      // Zugriff auf EINEN Space (spaceA) — die doppelte Klammerung fällt bei
      // genau einem Element nicht auf. ownerUserId (Admin-Token, Eigentümer
      // von spaceA UND spaceB) hat Lesezugriff auf BEIDE Spaces — genau der
      // Fall, der die zweite Klammerebene sichtbar macht.
      const ownerCookies = { [SESSION_COOKIE_NAME]: ownerSession }
      expect(await canReadSpace(permDeps, ownerUserId, spaceA)).toBe(true)
      expect(await canReadSpace(permDeps, ownerUserId, spaceB)).toBe(true)

      const res = await appAuth.inject({
        method: 'GET', url: `/api/search?q=${MARKER}`, cookies: ownerCookies,
      })
      expect(res.statusCode).toBe(200)
      const rows = res.json() as Array<{ id: string; space: string }>
      expect(rows.length).toBeGreaterThan(0)
      const spacesSeen = new Set(rows.map((r) => r.space))
      expect(spacesSeen.has('space-a')).toBe(true)
      expect(spacesSeen.has('space-b')).toBe(true)
    })

    it('viele hochrangige private Treffer verdrängen den einen zugänglichen Treffer nicht aus dem 25er-Fenster', async () => {
      // Regressionstest für Finding (d): Die Berechtigungs-Filterung muss VOR
      // ORDER BY/LIMIT in der WHERE-Klausel greifen. Space B (privat, für den
      // Reader nicht zugänglich) bekommt 30 Treffer mit maximalem Titel-Gewicht
      // (Rang weit oben), Space A (zugänglich) genau einen mit minimalem Gewicht
      // (Rang weit unten). Würde erst nach LIMIT 25 gefiltert, verdrängten die
      // 30 privaten Treffer den einen zugänglichen aus dem Ergebnis.
      const marker = 'verdraengungstestbegriff'
      for (let i = 0; i < 30; i++) {
        await insertRankedPage(db, {
          id: `b-noise-${i}`,
          spaceId: spaceB.id,
          title: `${marker} ${marker} ${marker}`,
          plainText: `${marker} ${marker} ${marker}`,
          weight: 'A',
        })
      }
      await insertRankedPage(db, {
        id: 'a-low-rank',
        spaceId: spaceA.id,
        title: 'Sonstiges',
        plainText: `Ganz am Ende dieses langen Textes taucht ${marker} nur ein einziges Mal auf.`,
        weight: 'D',
      })

      const res = await appAuth.inject({
        method: 'GET', url: `/api/search?q=${marker}`, cookies: cookies(),
      })
      expect(res.statusCode).toBe(200)
      const rows = res.json() as Array<{ id: string; space: string }>
      // Space A hat für diesen Marker nur den einen Treffer — er darf trotz 30
      // ranghöherer, unzugänglicher Treffer in Space B nicht verdrängt werden.
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe('a-low-rank')
      expect(rows[0].space).toBe('space-a')
    })

    it('Nutzer ohne Verknüpfung sieht gar nichts (leere Liste, tree/page 404)', async () => {
      const c = { [SESSION_COOKIE_NAME]: noAccountSession }
      const spaces = await appAuth.inject({ method: 'GET', url: '/api/spaces', cookies: c })
      expect(spaces.json()).toEqual([])
      const tree = await appAuth.inject({ method: 'GET', url: '/api/spaces/space-a/tree', cookies: c })
      expect(tree.statusCode).toBe(404)
      const page = await appAuth.inject({ method: 'GET', url: '/api/pages/a-home', cookies: c })
      expect(page.statusCode).toBe(404)
    })
  })

  describe('Schutz-Matrix', () => {
    it('/api/* ohne Session → 401', async () => {
      const res = await appAuth.inject({ method: 'GET', url: '/api/spaces' })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('session')
    })

    it('/api/openapi.json und /healthz bleiben ohne Session offen', async () => {
      const openapi = await appAuth.inject({ method: 'GET', url: '/api/openapi.json' })
      expect(openapi.statusCode).toBe(200)
      const health = await appAuth.inject({ method: 'GET', url: '/healthz' })
      expect(health.statusCode).toBe(200)
    })
  })

  describe('Ohne auth-Option bleibt alles offen (Bestandsverhalten)', () => {
    it('GET /api/spaces liefert ohne Session beide Spaces', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/api/spaces' })
      expect(res.statusCode).toBe(200)
      const ids = (res.json() as Array<{ id: string }>).map((s) => s.id).sort()
      expect(ids).toEqual(['space-a', 'space-b'])
    })

    it('tree und page von Space B sind ohne Session erreichbar', async () => {
      const tree = await appOpen.inject({ method: 'GET', url: '/api/spaces/space-b/tree' })
      expect(tree.statusCode).toBe(200)
      const page = await appOpen.inject({ method: 'GET', url: '/api/pages/b-home' })
      expect(page.statusCode).toBe(200)
    })
  })
})
