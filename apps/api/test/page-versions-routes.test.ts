import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { NotFoundError, type CommitInfo, type GitFile, type GitProvider } from '@f451/git-provider'
import { createDb, type Db } from '../src/db/client.js'
import { pages, pageVersions, spaces as spacesTable } from '../src/db/schema.js'
import { reconstructMissingVersions } from '../src/indexer/version-history.js'
import { registerVersionRoutes } from '../src/routes/versions.js'
import { clearMetadataSchemaCache } from '../src/spaces/metadata-schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/** Seitenversionierung Etappe 2: Versionsliste, Versionsdiff, Rekonstruktion. */

const space: SpaceConfig = {
  id: 'pv-space',
  name: 'Versionen',
  provider: 'forgejo',
  owner: 'o',
  repo: 'r',
  defaultLang: 'de',
  repoRef: { provider: 'forgejo', owner: 'o', repo: 'r' },
}
const PAGE_ID = 'p-versioniert'
const PAGE_PATH = 'versioniert/index.md'

const seite = (version: string, text: string, note = `Notiz ${version}`) =>
  `---\nid: ${PAGE_ID}\ntitle: Versioniert\nversion: ${version}\nchangelog:\n  - version: ${version}\n    date: 2026-07-1${version[2]}\n    author: Ada\n    note: ${note}\n---\n\n# Versioniert\n\n${text}\n`

/** Dateistände je Ref: `main`, Commit-SHAs und das Space-Schema. */
function fakeProvider(dateien: Record<string, string>, commits: CommitInfo[] = []): GitProvider {
  const lesen = async (_repo: unknown, path: string, ref: string): Promise<GitFile> => {
    const key = `${ref}:${path}`
    if (!(key in dateien)) throw new NotFoundError(`nicht gefunden: ${key}`)
    return { path, content: dateien[key]!, sha: `blob-${key}` }
  }
  return new Proxy({} as GitProvider, {
    get(_t, name) {
      if (name === 'readFile') return lesen
      if (name === 'listCommits') return async () => commits
      if (name === 'then') return undefined
      return () => {
        throw new Error(`unerwarteter Provider-Aufruf: ${String(name)}`)
      }
    },
  })
}

describe.sequential('Versionsliste, Versionsdiff und Rekonstruktion', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo, name: space.name, defaultLang: 'de',
    })
    await db.insert(pages).values({
      id: PAGE_ID, spaceId: space.id, path: PAGE_PATH, ref: 'main', title: 'Versioniert', lang: 'de',
      frontmatter: { tags: [], relations: {}, version: '1.10.0' },
    })
    const eintrag = (version: string, minor: number, mergeSha: string) => ({
      pageId: PAGE_ID, spaceId: space.id, version, major: 1, minor, patch: 0, mergeSha, blobSha: `b-${version}`,
      author: 'Ada', note: `Notiz ${version}`,
    })
    await db.insert(pageVersions).values([eintrag('1.2.0', 2, 'sha-120'), eintrag('1.10.0', 10, 'sha-1100'), eintrag('1.0.0', 0, 'sha-weg')])
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  beforeEach(() => clearMetadataSchemaCache())

  function app(provider: GitProvider, canRead = true): FastifyInstance {
    const a = Fastify()
    a.decorateRequest('user', null)
    a.addHook('onRequest', async (req) => {
      req.user = { id: 'leser', email: 'leser@test.local', displayName: 'Leser' }
    })
    registerVersionRoutes(a, {
      db,
      spaces: [space],
      providerRegistry: () => provider,
      access: { canRead: async () => canRead },
    })
    return a
  }

  const versioniert = { 'main:_meta/schema.yaml': 'versioning: true\nfields: []\n' }

  describe('GET /api/pages/:id/versions', () => {
    it('sortiert numerisch, neueste zuerst', async () => {
      const a = app(fakeProvider(versioniert))
      const res = await a.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/versions` })
      expect(res.statusCode).toBe(200)
      expect(res.json().versioning).toBe(true)
      expect(res.json().versions.map((v: { version: string }) => v.version)).toEqual(['1.10.0', '1.2.0', '1.0.0'])
      await a.close()
    })

    it('unversionierter Space → leere Liste, obwohl Zeilen existieren', async () => {
      const a = app(fakeProvider({}))
      const res = await a.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/versions` })
      expect(res.json()).toEqual({ versioning: false, versions: [] })
      await a.close()
    })

    it('ohne Leserecht dieselbe 404 wie für eine unbekannte Seite', async () => {
      const a = app(fakeProvider(versioniert), false)
      const ohne = await a.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/versions` })
      const unbekannt = await a.inject({ method: 'GET', url: '/api/pages/p-gibtsnicht/versions' })
      expect(ohne.statusCode).toBe(404)
      expect(unbekannt.statusCode).toBe(404)
      await a.close()
    })
  })

  describe('GET /api/pages/:id/diff', () => {
    it('vergleicht den Stand der Version (mergeSha) mit main', async () => {
      const a = app(
        fakeProvider({
          ...versioniert,
          [`sha-120:${PAGE_PATH}`]: seite('1.2.0', 'Alter Absatz.'),
          [`main:${PAGE_PATH}`]: seite('1.10.0', 'Neuer Absatz.'),
        }),
      )
      const res = await a.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/diff?from=1.2.0` })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.from.version).toBe('1.2.0')
      expect(body.to).toBe('1.10.0')
      expect(JSON.stringify(body.diff)).toContain('Neuer Absatz')
      expect(JSON.stringify(body.diff)).toContain('Alter Absatz')
      await a.close()
    })

    it('nicht mehr auflösbarer SHA → 410 statt 500', async () => {
      const a = app(fakeProvider({ ...versioniert, [`main:${PAGE_PATH}`]: seite('1.10.0', 'x') }))
      const res = await a.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/diff?from=1.0.0` })
      expect(res.statusCode).toBe(410)
      expect(res.json().reason).toMatch(/nicht mehr verfügbar/)
      await a.close()
    })

    it('unbekannte Version → 404, ohne Leserecht → 404', async () => {
      const a = app(fakeProvider(versioniert))
      expect((await a.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/diff?from=9.9.9` })).statusCode).toBe(404)
      await a.close()
      const b = app(fakeProvider(versioniert), false)
      expect((await b.inject({ method: 'GET', url: `/api/pages/${PAGE_ID}/diff?from=1.2.0` })).statusCode).toBe(404)
      await b.close()
    })
  })

  describe('reconstructMissingVersions', () => {
    const ID = 'p-rekonstruiert'
    const PFAD = 'rekonstruiert/index.md'
    const commit = (sha: string, date: string): CommitInfo => ({ sha, message: sha, authorName: 'Git-Autor', authorEmail: 'g@x', date })

    it('stellt page_versions aus der Historie wieder her und ist danach eine No-op', async () => {
      const inhalt = (v: string) => seite(v, `Text ${v}`).replace(PAGE_ID, ID)
      const dateien = {
        [`c1:${PFAD}`]: '---\nid: p-rekonstruiert\ntitle: Ohne Version\n---\n\nEntwurf\n',
        [`c2:${PFAD}`]: inhalt('1.0.0'),
        [`c3:${PFAD}`]: inhalt('1.0.0').replace('Text 1.0.0', 'Direkt-Commit ohne neue Version'),
        [`c4:${PFAD}`]: inhalt('1.1.0'),
      }
      // listCommits liefert neueste zuerst.
      const commits = [commit('c4', '2026-07-04T10:00:00Z'), commit('c3', '2026-07-03T10:00:00Z'), commit('c2', '2026-07-02T10:00:00Z'), commit('c1', '2026-07-01T10:00:00Z')]
      const provider = fakeProvider(dateien, commits)

      const warnungen: string[] = []
      const logger = { warn: (msg: string, meta?: Record<string, unknown>) => warnungen.push(`${msg} ${JSON.stringify(meta)}`) }
      const neu = await reconstructMissingVersions({ db, provider, logger }, space, [{ id: ID, path: PFAD, version: '1.1.0' }])
      expect(warnungen).toEqual([])
      expect(neu).toBe(2)

      const rows = await db.select().from(pageVersions).where(eq(pageVersions.pageId, ID))
      const nach = Object.fromEntries(rows.map((r) => [r.version, r]))
      expect(Object.keys(nach).sort()).toEqual(['1.0.0', '1.1.0'])
      expect(nach['1.0.0']!.mergeSha).toBe('c2')
      expect(nach['1.0.0']!.blobSha).toBe(`blob-c2:${PFAD}`)
      expect(nach['1.1.0']!.author).toBe('Ada')
      expect(nach['1.1.0']!.note).toBe('Notiz 1.1.0')

      // Aktuelle Version vorhanden → kein weiterer Historien-Scan.
      const stumm = fakeProvider({}, [])
      expect(await reconstructMissingVersions({ db, provider: stumm }, space, [{ id: ID, path: PFAD, version: '1.1.0' }])).toBe(0)
    })

    it('Seiten ohne Version werden übersprungen, ohne den Provider zu fragen', async () => {
      const stumm = fakeProvider({}, [])
      expect(await reconstructMissingVersions({ db, provider: stumm }, space, [{ id: 'p-ohne', path: 'x.md', version: undefined }])).toBe(0)
    })
  })
})
