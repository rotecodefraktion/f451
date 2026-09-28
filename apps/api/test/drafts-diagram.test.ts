import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { NotFoundError, ProviderError, type GitProvider } from '@f451/git-provider'
import {
  DIAGRAM_SUFFIXES,
  DiagramExistsError,
  DiagramPathError,
  saveDiagram,
  type SaveDiagramInput,
} from '../src/drafts/diagram.js'
import { PayloadTooLargeError, UnsupportedMediaTypeError } from '../src/drafts/upload.js'
import { registerDraftsRoutes, type DraftsDeps } from '../src/routes/drafts.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const repo = { provider: 'forgejo' as const, owner: 'acme', repo: 'docs' }
const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

/** Erwarteter Aufruf-Datensatz für `writeCalls` (siehe `fakeProvider` unten). */
interface WriteCall {
  path: string
  content: string
  opts: { branch: string; message: string; sha?: string }
}

/** Minimaler In-Memory-GitProvider für `saveDiagram` (gleiches Muster wie
 *  `drafts-upload.test.ts#fakeProvider`): nur `readFileBinary`/`writeFile`
 *  werden von `saveDiagram` benutzt. `existing` seedet den Bestand
 *  (`path -> sha`), `writeCalls` zeichnet jeden `writeFile`-Aufruf auf. */
function fakeProvider(existing: Record<string, string> = {}): { provider: GitProvider; writeCalls: WriteCall[] } {
  const files = new Map<string, string>(Object.entries(existing))
  const writeCalls: WriteCall[] = []
  const unexpected = (name: string) => (): never => {
    throw new Error(`fakeProvider.${name}: im Test nicht erwartet`)
  }
  const provider: GitProvider = {
    readFile: unexpected('readFile'),
    async readFileBinary(_repo, path) {
      const sha = files.get(path)
      if (sha === undefined) throw new NotFoundError('nicht gefunden')
      return { content: Buffer.from('irrelevant'), sha }
    },
    listTree: unexpected('listTree'),
    getHeadSha: unexpected('getHeadSha'),
    async writeFile(_repo, path, content, opts) {
      writeCalls.push({ path, content, opts })
      files.set(path, 'neuer-sha')
      return { commitSha: 'irrelevant' }
    },
    writeFileBinary: unexpected('writeFileBinary'),
    createBranch: unexpected('createBranch'),
    deleteBranch: unexpected('deleteBranch'),
    listCommits: unexpected('listCommits'),
    createPullRequest: unexpected('createPullRequest'),
    getPullRequest: unexpected('getPullRequest'),
    mergePullRequest: unexpected('mergePullRequest'),
  }
  return { provider, writeCalls }
}

/** Provider, dessen Methoden bei Aufruf sofort werfen — für Fälle, die VOR
 *  jedem Git-Zugriff mit einem clientseitigen Fehler enden müssen (beweist:
 *  kein Seiteneffekt, siehe `drafts-routes-permissions.test.ts`). */
function unreachableProvider(): GitProvider {
  const fail = (): never => {
    throw new Error('GitProvider darf für abgelehnte Anfragen nicht aufgerufen werden.')
  }
  return {
    readFile: fail, readFileBinary: fail, listTree: fail, getHeadSha: fail, writeFile: fail,
    writeFileBinary: fail, createBranch: fail, deleteBranch: fail, listCommits: fail,
    createPullRequest: fail, getPullRequest: fail, mergePullRequest: fail,
  }
}

// --- Unit: saveDiagram gegen Stub-Provider ----------------------------------

describe('saveDiagram (Phase 3e Task 2)', () => {
  it('legt eine neue Datei auf dem Draft-Branch an (ifAbsent)', async () => {
    const { provider, writeCalls } = fakeProvider()
    const input: SaveDiagramInput = { path: '_media/fluss.drawio.svg', content: VALID_SVG, ifAbsent: true }

    const result = await saveDiagram(provider, repo, 'p1', 'docs/seite.md', input, 10_000_000)

    expect(result).toEqual({ path: '_media/fluss.drawio.svg' })
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]).toMatchObject({
      path: 'docs/_media/fluss.drawio.svg',
      opts: { branch: 'draft/p1' },
    })
    expect(writeCalls[0].opts.sha).toBeUndefined()
  })

  it('überschreibt eine bestehende Datei in place (mit sha)', async () => {
    const { provider, writeCalls } = fakeProvider({ 'docs/_media/fluss.drawio.svg': 'abc123' })

    await saveDiagram(provider, repo, 'p1', 'docs/seite.md', { path: '_media/fluss.drawio.svg', content: VALID_SVG }, 10_000_000)

    expect(writeCalls[0]?.opts.sha).toBe('abc123')
  })

  it('ifAbsent + Datei existiert → DiagramExistsError, kein Commit', async () => {
    const { provider, writeCalls } = fakeProvider({ 'docs/_media/fluss.drawio.svg': 'abc123' })

    await expect(
      saveDiagram(
        provider,
        repo,
        'p1',
        'docs/seite.md',
        { path: '_media/fluss.drawio.svg', content: VALID_SVG, ifAbsent: true },
        10_000_000,
      ),
    ).rejects.toBeInstanceOf(DiagramExistsError)
    expect(writeCalls).toHaveLength(0)
  })

  it('sanitisiert den Inhalt vor dem Commit (Skript raus, Payload-Kommentar bleibt)', async () => {
    const { provider, writeCalls } = fakeProvider()
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><!-- payload-start -->x<!-- payload-end --><script>alert(1)</script><rect width="1" height="1"/></svg>'

    await saveDiagram(provider, repo, 'p1', 'seite.md', { path: '_media/s.excalidraw.svg', content: dirty }, 10_000_000)

    expect(writeCalls[0]?.content).not.toContain('<script')
    expect(writeCalls[0]?.content).toContain('payload-start')
  })

  it('Wurzelseite: _media direkt neben der Seite', async () => {
    const { provider, writeCalls } = fakeProvider()

    await saveDiagram(provider, repo, 'p1', 'index.md', { path: '_media/a.drawio.svg', content: VALID_SVG }, 10_000_000)

    expect(writeCalls[0]?.path).toBe('_media/a.drawio.svg')
  })

  it.each([
    '_media/../evil.drawio.svg',
    '_media/a/b.drawio.svg',
    'anderswo/x.drawio.svg',
    '_media/.drawio.svg',
    '/etc/x.drawio.svg',
    '_media/',
    '',
  ])('lehnt ungültigen Pfad ab: %s', async (path) => {
    const provider = unreachableProvider()
    await expect(
      saveDiagram(provider, repo, 'p1', 'seite.md', { path, content: VALID_SVG }, 10_000_000),
    ).rejects.toBeInstanceOf(DiagramPathError)
  })

  it('lehnt fremde Suffixe ab (415-Klasse)', async () => {
    const provider = unreachableProvider()
    await expect(
      saveDiagram(provider, repo, 'p1', 'seite.md', { path: '_media/x.svg', content: VALID_SVG }, 10_000_000),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
  })

  it('lehnt zu große Inhalte ab (413-Klasse)', async () => {
    const provider = unreachableProvider()
    await expect(
      saveDiagram(provider, repo, 'p1', 'seite.md', { path: '_media/x.drawio.svg', content: VALID_SVG }, 8),
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('DIAGRAM_SUFFIXES enthält genau die zwei erlaubten Endungen', () => {
    expect(DIAGRAM_SUFFIXES).toEqual(['.drawio.svg', '.excalidraw.svg'])
  })
})

// --- Route: Gates + Status-Mapping über app.inject --------------------------

describe.sequential('PUT /api/pages/:id/draft/diagram (Phase 3e Task 2, gestubbt)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'stub-space-diagram',
    name: 'Stub Space Diagram',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo-diagram',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo-diagram' },
  }
  const pageId = 'home'
  const pagePath = 'index.md'

  // EIN PG-Container für den ganzen Block (Muster
  // `drafts-routes-permissions.test.ts`) statt pro Test — ein frischer
  // Testcontainer pro `it()` sprengt unter Last locker den (nicht global
  // erhöhten) Default-Timeout von Vitest (5s) allein durch die
  // Containerstartzeit.
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
    })
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  function buildTestApp(deps: DraftsDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerDraftsRoutes(app, deps)
    return app
  }

  function baseDeps(provider: GitProvider, overrides: Partial<DraftsDeps> = {}): DraftsDeps {
    return {
      db,
      spaces: [space],
      access: { canRead: async () => true },
      canWrite: async () => true,
      getUserProvider: async () => provider,
      ...overrides,
    }
  }

  it('200 mit { path } im Erfolgsfall; Commit auf draft/<pageId>', async () => {
    const { provider, writeCalls } = fakeProvider()
    const app = buildTestApp(baseDeps(provider))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ path: '_media/plan.drawio.svg' })
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]).toMatchObject({ path: '_media/plan.drawio.svg', opts: { branch: 'draft/home' } })

    await app.close()
  })

  it('409 bei ifAbsent-Kollision', async () => {
    const { provider } = fakeProvider({ '_media/plan.drawio.svg': 'abc123' })
    const app = buildTestApp(baseDeps(provider))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG, ifAbsent: true },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().reason).toBeTruthy()

    await app.close()
  })

  it('400 bei Traversal-Pfad, 415 bei fremdem Suffix, 422 bei invalider SVG — kein Provider-Aufruf', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider()))
    await app.ready()

    const badPath = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/../evil.drawio.svg', content: VALID_SVG },
    })
    expect(badPath.statusCode).toBe(400)

    const badSuffix = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.svg', content: VALID_SVG },
    })
    expect(badSuffix.statusCode).toBe(415)

    const badSvg = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    })
    expect(badSvg.statusCode).toBe(422)

    await app.close()
  })

  it('ohne Schreibrecht → 403, kein Commit', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider(), { canWrite: async () => false }))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG },
    })

    expect(res.statusCode).toBe(403)

    await app.close()
  })

  it('unbekannte Seite → 404 (kein Existenz-Orakel)', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider()))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/pages/does-not-exist/draft/diagram',
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG },
    })

    expect(res.statusCode).toBe(404)

    await app.close()
  })

  it('Body über Fastifys Default-bodyLimit (1 MiB) → 413 mit {status,reason}, nie 500 (Fix-Runde 1, Finding 1)', async () => {
    // maxUploadMb: 1 → inhaltliches Limit 1 MiB, Routen-bodyLimit 2 MiB.
    // Der ~1.2-MiB-Body liegt ÜBER Fastifys Default-bodyLimit (1 MiB) — ohne
    // das explizite bodyLimit an der Route würde Fastify den Body mit seiner
    // eigenen Fehlerform ablehnen, die mit dem errorSchema kollidiert (500
    // FST_ERR_FAILED_ERROR_SERIALIZATION). Mit Fix erreicht der Body den
    // Handler und läuft in die saubere 413-Antwort von saveDiagram.
    const app = buildTestApp(baseDeps(unreachableProvider(), { maxUploadMb: 1 }))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/gross.drawio.svg', content: 'x'.repeat(1_200_000) },
    })

    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ status: 'payload_too_large' })
    expect(res.json().reason).toBeTruthy()

    await app.close()
  })

  it('Body ohne content → 400 mit {status,reason}, nie 500 (Fix-Runde 1, Finding 2)', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider()))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
    expect(res.json().reason).toBeTruthy()

    await app.close()
  })

  it('content als Zahl → 400, nie 500 (Fix-Runde 1, Finding 2)', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider()))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: 12345 },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })

    await app.close()
  })

  it('path fehlt oder Body ist kein Objekt → 400, nie 500 (Fix-Runde 1, Finding 2)', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider()))
    await app.ready()

    const missingPath = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { content: VALID_SVG },
    })
    expect(missingPath.statusCode).toBe(400)
    expect(missingPath.json()).toMatchObject({ status: 'bad_request' })

    const scalarBody = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1', 'content-type': 'application/json' },
      payload: '"nur-ein-string"',
    })
    expect(scalarBody.statusCode).toBe(400)
    expect(scalarBody.json()).toMatchObject({ status: 'bad_request' })

    await app.close()
  })

  it('fehlgeformtes ifAbsent (String "true") → 400, kein stilles Überschreiben (4a-Final-Triage)', async () => {
    // Vorher (Fix-Runde 1, Finding 2): nicht-boolesches `ifAbsent` wurde
    // tolerant als "nicht gesetzt" gewertet — das verwandelte eine gewollte
    // Kollisionsprüfung lautlos in ein Überschreiben. Jetzt: 400 statt
    // Silent-Overwrite, KEIN Provider-Aufruf (Datei existiert bereits und
    // würde bei echtem `ifAbsent: true` mit 409 abgelehnt).
    const { provider, writeCalls } = fakeProvider({ '_media/plan.drawio.svg': 'abc123' })
    const app = buildTestApp(baseDeps(provider))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG, ifAbsent: 'true' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
    expect(res.json().reason).toBeTruthy()
    expect(writeCalls).toHaveLength(0)

    await app.close()
  })

  it('ifAbsent als Zahl (1) → 400, nie 500', async () => {
    const app = buildTestApp(baseDeps(unreachableProvider()))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG, ifAbsent: 1 },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
    expect(res.json().reason).toBeTruthy()

    await app.close()
  })

  it('Regression: ifAbsent true/false/fehlt bleiben unverändert korrekt', async () => {
    // ifAbsent: true, Datei existiert nicht → 200, Commit ohne sha.
    {
      const { provider, writeCalls } = fakeProvider()
      const app = buildTestApp(baseDeps(provider))
      await app.ready()

      const res = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft/diagram`,
        headers: { 'x-test-user': 'u1' },
        payload: { path: '_media/plan.drawio.svg', content: VALID_SVG, ifAbsent: true },
      })

      expect(res.statusCode).toBe(200)
      expect(writeCalls).toHaveLength(1)
      expect(writeCalls[0]?.opts.sha).toBeUndefined()

      await app.close()
    }

    // ifAbsent: false, Datei existiert bereits → 200, Commit mit sha (Überschreiben erlaubt).
    {
      const { provider, writeCalls } = fakeProvider({ '_media/plan.drawio.svg': 'abc123' })
      const app = buildTestApp(baseDeps(provider))
      await app.ready()

      const res = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft/diagram`,
        headers: { 'x-test-user': 'u1' },
        payload: { path: '_media/plan.drawio.svg', content: VALID_SVG, ifAbsent: false },
      })

      expect(res.statusCode).toBe(200)
      expect(writeCalls).toHaveLength(1)
      expect(writeCalls[0]?.opts.sha).toBe('abc123')

      await app.close()
    }

    // ifAbsent fehlt, Datei existiert bereits → 200, Commit mit sha (Standardverhalten: Überschreiben).
    {
      const { provider, writeCalls } = fakeProvider({ '_media/plan.drawio.svg': 'abc123' })
      const app = buildTestApp(baseDeps(provider))
      await app.ready()

      const res = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft/diagram`,
        headers: { 'x-test-user': 'u1' },
        payload: { path: '_media/plan.drawio.svg', content: VALID_SVG },
      })

      expect(res.statusCode).toBe(200)
      expect(writeCalls).toHaveLength(1)
      expect(writeCalls[0]?.opts.sha).toBe('abc123')

      await app.close()
    }
  })

  it('Provider-Fehler beim Schreiben → 502, nie 500', async () => {
    const broken: GitProvider = {
      ...unreachableProvider(),
      async readFileBinary(): Promise<never> {
        throw new NotFoundError('nicht gefunden')
      },
      async writeFile(): Promise<never> {
        throw new ProviderError('Provider nicht erreichbar')
      },
    }
    const app = buildTestApp(baseDeps(broken))
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft/diagram`,
      headers: { 'x-test-user': 'u1' },
      payload: { path: '_media/plan.drawio.svg', content: VALID_SVG },
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().reason).toBeTruthy()

    await app.close()
  })
})
