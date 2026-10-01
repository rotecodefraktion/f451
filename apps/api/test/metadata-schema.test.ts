import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { parseMetadataSchema } from '@f451/markdown'
import {
  clearMetadataSchemaCache,
  loadMetadataSchema,
  METADATA_SCHEMA_PATH,
  type MetadataSchemaDeps,
} from '../src/spaces/metadata-schema.js'
import { registerMetadataSchemaRoutes, type MetadataSchemaRouteDeps } from '../src/routes/metadata-schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'

/**
 * Metadaten-Feature M1 (Backend-Fundament), Task 2 (Schema-Loader) + Task 4
 * (Schema-Route). Bewusst OHNE Postgres-/Forgejo-Testcontainer: der Loader
 * hängt nur vom `GitProvider`-Vertrag ab (Muster `pages-routes.test.ts`/
 * `provider-down.test.ts`: handgebauter Fake-Provider statt echtem Forgejo),
 * die Route braucht keine DB (`MetadataSchemaRouteDeps` hat keine `db`).
 */

const space: SpaceConfig = {
  id: 'meta-space',
  name: 'Meta Space',
  provider: 'forgejo',
  owner: 'stub-owner',
  repo: 'stub-repo',
  defaultLang: 'de',
  repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
}

const noopLogger = { warn: () => {} }

/** Fake-Provider: NUR `readFile` ist konfigurierbar, jede andere Methode wirft
 *  (beweist, dass der Loader keine anderen Provider-Methoden benutzt). */
function providerWithSchemaFile(content: string | Error): GitProvider {
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: im Metadaten-Schema-Loader nicht erwartet`)
  }
  return {
    async readFile(_repo, path, ref) {
      if (content instanceof Error) throw content
      expect(path).toBe(METADATA_SCHEMA_PATH)
      expect(ref).toBe('main')
      return { path, content, sha: 'abc' }
    },
    readFileBinary: fail('readFileBinary'),
    listTree: fail('listTree'),
    getHeadSha: fail('getHeadSha'),
    writeFile: fail('writeFile'),
    writeFileBinary: fail('writeFileBinary'),
    createBranch: fail('createBranch'),
    deleteBranch: fail('deleteBranch'),
    listCommits: fail('listCommits'),
    createPullRequest: fail('createPullRequest'),
    getPullRequest: fail('getPullRequest'),
    listPullRequests: fail('listPullRequests'),
    requestReviewers: fail('requestReviewers'),
    submitPullRequestReview: fail('submitPullRequestReview'),
    mergePullRequest: fail('mergePullRequest'),
  }
}

describe('loadMetadataSchema (Loader)', () => {
  afterEach(() => {
    clearMetadataSchemaCache()
    vi.restoreAllMocks()
  })

  it('liest und parst eine gültige _meta/schema.yaml über readFile(main)', async () => {
    const provider = providerWithSchemaFile(
      'fields:\n  - key: process_id\n    label: Process ID\n    type: text\n',
    )
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    const schema = await loadMetadataSchema(deps, space, 'main', noopLogger)
    expect(schema.fields).toEqual([{ key: 'process_id', label: 'Process ID', type: 'text' }])
  })

  it('fehlende Datei (NotFoundError) → leeres Schema, KEIN Warn-Log (Normalfall)', async () => {
    const provider = providerWithSchemaFile(new NotFoundError('nicht gefunden'))
    const warn = vi.fn()
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    const schema = await loadMetadataSchema(deps, space, 'main', { warn })
    expect(schema).toEqual({ fields: [], versioning: false })
    expect(warn).not.toHaveBeenCalled()
  })

  it('anderer Provider-Fehler (Ausfall) → leeres Schema, MIT Warn-Log (fail-soft, wirft nie)', async () => {
    const provider = providerWithSchemaFile(new Error('simulierter Provider-Ausfall'))
    const warn = vi.fn()
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    const schema = await loadMetadataSchema(deps, space, 'main', { warn })
    expect(schema).toEqual({ fields: [], versioning: false })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('kaputtes YAML in vorhandener Datei → leeres Schema, Fehler geloggt, wirft nie', async () => {
    const provider = providerWithSchemaFile('fields: [kaputt')
    const warn = vi.fn()
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    const schema = await loadMetadataSchema(deps, space, 'main', { warn })
    expect(schema).toEqual({ fields: [], versioning: false })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('ungültige einzelne Felder → gültige bleiben erhalten, Fehler geloggt (granulares Fail-Soft)', async () => {
    const provider = providerWithSchemaFile(
      'fields:\n'
        + '  - key: gut\n    label: Gut\n    type: text\n'
        + '  - key: schlecht\n    label: Schlecht\n    type: nonsense\n',
    )
    const warn = vi.fn()
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    const schema = await loadMetadataSchema(deps, space, 'main', { warn })
    expect(schema.fields).toEqual([{ key: 'gut', label: 'Gut', type: 'text' }])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('cached Ergebnis innerhalb der TTL — readFile wird nur einmal aufgerufen', async () => {
    let calls = 0
    const provider: GitProvider = {
      ...providerWithSchemaFile('fields: []'),
      async readFile(repo, path, ref) {
        calls += 1
        return providerWithSchemaFile('fields: []').readFile(repo, path, ref)
      },
    }
    let now = 1_000_000
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider, now: () => now }
    await loadMetadataSchema(deps, space, 'main', noopLogger)
    await loadMetadataSchema(deps, space, 'main', noopLogger)
    expect(calls).toBe(1)

    // Nach Ablauf der TTL (5 min) wird erneut gelesen.
    now += 5 * 60 * 1000 + 1
    await loadMetadataSchema(deps, space, 'main', noopLogger)
    expect(calls).toBe(2)
  })

  it('Cache ist pro (Space, Ref) getrennt — unterschiedliche Refs treffen den Provider je einmal', async () => {
    let calls = 0
    const makeProvider = (): GitProvider => ({
      ...providerWithSchemaFile('fields: []'),
      async readFile() {
        calls += 1
        return { path: METADATA_SCHEMA_PATH, content: 'fields: []', sha: 'x' }
      },
    })
    const provider = makeProvider()
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    await loadMetadataSchema(deps, space, 'main', noopLogger)
    await loadMetadataSchema(deps, space, 'draft', noopLogger)
    expect(calls).toBe(2)
  })

  it('clearMetadataSchemaCache leert den Cache — nächster Aufruf liest erneut', async () => {
    let calls = 0
    const provider: GitProvider = {
      ...providerWithSchemaFile('fields: []'),
      async readFile() {
        calls += 1
        return { path: METADATA_SCHEMA_PATH, content: 'fields: []', sha: 'x' }
      },
    }
    const deps: MetadataSchemaDeps = { providerRegistry: () => provider }
    await loadMetadataSchema(deps, space, 'main', noopLogger)
    clearMetadataSchemaCache()
    await loadMetadataSchema(deps, space, 'main', noopLogger)
    expect(calls).toBe(2)
  })
})

describe('GET /api/spaces/:space/metadata-schema (Route)', () => {
  afterEach(() => {
    clearMetadataSchemaCache()
  })

  function buildTestApp(deps: MetadataSchemaRouteDeps): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    registerMetadataSchemaRoutes(app, deps)
    return app
  }

  it('liefert 200 mit dem geparsten Schema', async () => {
    const provider = providerWithSchemaFile(
      'fields:\n  - key: process_id\n    label: Process ID\n    type: text\n',
    )
    const app = buildTestApp({ spaces: [space], providerRegistry: () => provider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${space.id}/metadata-schema` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      fields: [{ key: 'process_id', label: 'Process ID', type: 'text' }],
      versioning: false,
    })
    await app.close()
  })

  it('liefert 200 mit leerem Schema, wenn keine Datei existiert', async () => {
    const provider = providerWithSchemaFile(new NotFoundError('nicht gefunden'))
    const app = buildTestApp({ spaces: [space], providerRegistry: () => provider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${space.id}/metadata-schema` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fields: [], versioning: false })
    await app.close()
  })

  it('Space mit versioning: true → GET liefert den Schalter tatsächlich in der HTTP-Antwort (Response-Schema-Fix, Befund aus Etappe 1)', async () => {
    // Vorher filterte Fastifys Response-Schema `versioning` aus der Antwort
    // heraus (fehlte in `metadataSchemaResponseSchema.response[200].properties`),
    // OBWOHL der Loader das Feld intern korrekt kannte (s. `loadMetadataSchema`-
    // Tests oben: `versioning: true` steckt im geparsten Schema). Der
    // Schema-Editor bekam den Schalter dadurch nie zu sehen und schickte ihn
    // beim Speichern folglich nicht zurück — stiller Datenverlust eine Ebene
    // über dem bereits gefixten PUT-Body-Filtering.
    const provider = providerWithSchemaFile('versioning: true\nfields: []\n')
    const app = buildTestApp({ spaces: [space], providerRegistry: () => provider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${space.id}/metadata-schema` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fields: [], versioning: true })
    await app.close()
  })

  it('unbekannter Space → 404', async () => {
    const provider = providerWithSchemaFile(new NotFoundError('nicht gefunden'))
    const app = buildTestApp({ spaces: [space], providerRegistry: () => provider })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/spaces/nicht-konfiguriert/metadata-schema' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('kein Zugriff (access.canRead=false) → 404 statt 403 (kein Existenz-Orakel)', async () => {
    const provider = providerWithSchemaFile(new NotFoundError('nicht gefunden'))
    const app = buildTestApp({
      spaces: [space],
      providerRegistry: () => provider,
      access: { canRead: async () => false },
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('mit Zugriff (access.canRead=true) → 200', async () => {
    const provider = providerWithSchemaFile('fields: []')
    const app = buildTestApp({
      spaces: [space],
      providerRegistry: () => provider,
      access: { canRead: async () => true },
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fields: [], versioning: false })
    await app.close()
  })
})

/**
 * Metadaten-Feature M4 (Schema-Editor-UI), Task „Schreib-Route": `PUT
 * /api/spaces/:space/metadata-schema` committet ein neues `_meta/schema.yaml`
 * DIREKT auf `main` — Muster `routes/templates.ts`s `POST .../templates`
 * (Schreibrecht-Gate über `resolveNewPageWriteContext`, Schreiben mit dem
 * NUTZER-Provider statt der Service-Account-`providerRegistry`). Bewusst
 * derselbe Fake-Provider-/Fake-Gate-Ansatz wie oben (kein Postgres-/Forgejo-
 * Testcontainer) — die Route hängt nur vom `GitProvider`-Vertrag +
 * `NewPageGateDeps`-Vertrag ab.
 */
describe('PUT /api/spaces/:space/metadata-schema (Route)', () => {
  afterEach(() => {
    clearMetadataSchemaCache()
  })

  /** In-Memory-Fake, der `readFile` (für den sha-Lookup vor dem Update) UND
   *  `writeFile` (die eigentliche Schreiboperation) unterstützt — jede andere
   *  Methode wirft (beweist, dass die Route keine anderen Provider-Methoden
   *  benutzt). `initialContent === undefined` simuliert "Datei existiert noch
   *  nicht" (erster Speicherstand eines Space ohne `_meta/schema.yaml`). */
  function makeWritableProvider(initialContent?: string) {
    let fileContent = initialContent
    let fileSha = initialContent !== undefined ? 'sha-initial' : undefined
    const writes: Array<{ path: string; content: string; opts: { branch: string; message: string; sha?: string } }> = []
    const fail = (name: string) => (): never => {
      throw new Error(`GitProvider.${name}: in der Schema-Schreib-Route nicht erwartet`)
    }
    const provider: GitProvider = {
      async readFile(_repo, path, ref) {
        expect(path).toBe(METADATA_SCHEMA_PATH)
        expect(ref).toBe('main')
        if (fileContent === undefined) throw new NotFoundError('nicht gefunden')
        return { path, content: fileContent, sha: fileSha! }
      },
      readFileBinary: fail('readFileBinary'),
      listTree: fail('listTree'),
      getHeadSha: fail('getHeadSha'),
      async writeFile(_repo, path, content, opts) {
        expect(path).toBe(METADATA_SCHEMA_PATH)
        writes.push({ path, content, opts })
        fileContent = content
        fileSha = `sha-${writes.length}`
        return { commitSha: `commit-${writes.length}` }
      },
      writeFileBinary: fail('writeFileBinary'),
      createBranch: fail('createBranch'),
      deleteBranch: fail('deleteBranch'),
      listCommits: fail('listCommits'),
      createPullRequest: fail('createPullRequest'),
      getPullRequest: fail('getPullRequest'),
      listPullRequests: fail('listPullRequests'),
      requestReviewers: fail('requestReviewers'),
      submitPullRequestReview: fail('submitPullRequestReview'),
      mergePullRequest: fail('mergePullRequest'),
    }
    return { provider, writes }
  }

  interface GateOptions {
    canRead?: boolean
    canWrite?: boolean
    /** `false` simuliert ein NICHT verknüpftes Provider-Konto (`getUserProvider` → `null`). */
    connected?: boolean
  }

  function buildTestApp(routeDeps: {
    provider: GitProvider
    gate?: GateOptions
    readProvider?: GitProvider
  }): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    const gate = routeDeps.gate ?? {}
    registerMetadataSchemaRoutes(app, {
      spaces: [space],
      providerRegistry: () => routeDeps.readProvider ?? routeDeps.provider,
      access: { canRead: async () => gate.canRead ?? true },
      canWrite: async () => gate.canWrite ?? true,
      getUserProvider: async () => (gate.connected === false ? null : routeDeps.provider),
    })
    return app
  }

  const validFields = [
    { key: 'process_id', label: 'Process ID', type: 'pattern', pattern: '^SAP-P-\\d{4}$', required: true },
    { key: 'status', label: 'Status', type: 'enum', options: ['Entwurf', 'Freigegeben'] },
  ]

  it('legt _meta/schema.yaml an, wenn noch keine Datei existiert (kein sha im writeFile-Aufruf)', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fields: validFields, versioning: false })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.opts.sha).toBeUndefined()
    expect(writes[0]!.opts.branch).toBe('main')

    // Geschriebener Inhalt muss vom echten Parser wieder korrekt gelesen werden.
    const { schema, errors } = parseMetadataSchema(writes[0]!.content)
    expect(errors).toEqual([])
    expect(schema.fields).toEqual(validFields)
    await app.close()
  })

  it('PUT mit versioning: true schreibt den Schalter in die YAML (Datenverlust-Fix)', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields, versioning: true },
    })

    expect(res.statusCode).toBe(200)
    // Auch die HTTP-Antwort selbst muss den Schalter tragen (Response-Schema-
    // Fix) — sonst sähe ein Client, der die PUT-Antwort statt eines erneuten
    // GET zur Aktualisierung seines Zustands nutzt (s. `MetadataSchemaEditor`),
    // den Schalter trotz erfolgreichem Schreiben nicht.
    expect(res.json()).toEqual({ fields: validFields, versioning: true })
    expect(writes).toHaveLength(1)
    // Der eigentliche Beweis: die geschriebene YAML trägt den Schalter — vorher
    // ging er in `parseMetadataSchemaFromValue({ fields: req.body.fields })`
    // (ohne `versioning`) verloren, weil das Feld aus dem Body nie durchgereicht wurde.
    const { schema, errors } = parseMetadataSchema(writes[0]!.content)
    expect(errors).toEqual([])
    expect(schema.versioning).toBe(true)
    await app.close()
  })

  it('PUT keeps the classification block, GET returns it', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const classification = { default: 'internal', max: 'confidential' }
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields, versioning: false, classification },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().classification).toEqual(classification)
    expect(parseMetadataSchema(writes[0]!.content).schema.classification).toEqual(classification)
    await app.close()
  })

  it('versioning mit falschem Typ → 400 (NICHT 500), KEIN Schreibversuch (Regressionstest Etappe 1)', async () => {
    // Vorher listete das Body-Schema `versioning: { type: 'boolean' }` — AJV
    // wies `"ja"` schon VOR dem Handler ab, Fastifys generische Validierungs-
    // fehlerantwort scheiterte dann am 400-Response-Schema (das `errors`
    // verlangt) und die Serialisierung brach mit 500 ab. Das etablierte
    // Muster (wie bei `fields`) ist: KEIN Typ-Constraint im Body-Schema, die
    // Validierung läuft stattdessen im Handler über
    // `parseMetadataSchemaFromValue`, deren Meldung hier wörtlich erwartet wird.
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields, versioning: 'ja' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.status).toBe('bad_request')
    expect(body.errors).toContain('versioning: muss true oder false sein')
    expect(writes).toHaveLength(0)
    await app.close()
  })

  it('aktualisiert eine bestehende Datei MIT sha (Update statt Anlage)', async () => {
    const { provider, writes } = makeWritableProvider('fields: []')
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields },
    })

    expect(res.statusCode).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.opts.sha).toBe('sha-initial')
    await app.close()
  })

  it('invalidiert den Lese-Cache — GET liefert danach das neue Schema statt des gecachten alten Stands', async () => {
    const { provider } = makeWritableProvider('fields: []')
    const app = buildTestApp({ provider })
    await app.ready()

    // Erst GET (füllt den Cache mit dem leeren Schema)...
    const before = await app.inject({
      method: 'GET',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
    })
    expect(before.json()).toEqual({ fields: [], versioning: false })

    // ...dann PUT (schreibt ein neues Schema)...
    const put = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields },
    })
    expect(put.statusCode).toBe(200)

    // ...GET muss danach den NEUEN Stand liefern, nicht den gecachten alten.
    const after = await app.inject({
      method: 'GET',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
    })
    expect(after.json()).toEqual({ fields: validFields, versioning: false })
    await app.close()
  })

  it('doppelter key → 400 mit Feldfehlern, KEIN Schreibversuch', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: {
        fields: [
          { key: 'dup', label: 'Erster', type: 'text' },
          { key: 'dup', label: 'Zweiter', type: 'text' },
        ],
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.status).toBe('bad_request')
    expect(body.errors.some((e: string) => e.includes('bereits vergeben'))).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('ungültiges pattern-Regex → 400 mit Feldfehlern, KEIN Schreibversuch', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: [{ key: 'p', label: 'P', type: 'pattern', pattern: '[kaputt' }] },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.status).toBe('bad_request')
    expect(body.errors.some((e: string) => e.includes('regulärer Ausdruck'))).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('enum-Feld ohne options (type-spezifisches Pflichtfeld fehlt) → 400, KEIN Schreibversuch', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: [{ key: 'e', label: 'E', type: 'enum' }] },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.status).toBe('bad_request')
    expect(body.errors.some((e: string) => e.includes('"options"'))).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('"fields" fehlt/ist kein Array → 400', async () => {
    const { provider } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().status).toBe('bad_request')
  })

  it('leeres fields-Array ist gültig (erster Speicherstand eines Space ohne Schema)', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'writer' },
      payload: { fields: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fields: [], versioning: false })
    expect(writes).toHaveLength(1)
  })

  it('kein Schreibrecht (canWrite=false) → 403', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider, gate: { canWrite: false } })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'reader' },
      payload: { fields: validFields },
    })
    expect(res.statusCode).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('kein verknüpftes Provider-Konto (getUserProvider → null) → 403', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider, gate: { connected: false } })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'nobody' },
      payload: { fields: validFields },
    })
    expect(res.statusCode).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('kein Lesezugriff (access.canRead=false) → 404 (kein Existenz-Orakel)', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider, gate: { canRead: false } })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      headers: { 'x-test-user': 'outsider' },
      payload: { fields: validFields },
    })
    expect(res.statusCode).toBe(404)
    expect(writes).toHaveLength(0)
  })

  it('unbekannter Space → 404', async () => {
    const { provider, writes } = makeWritableProvider(undefined)
    const app = buildTestApp({ provider })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/spaces/gibt-es-nicht/metadata-schema',
      headers: { 'x-test-user': 'writer' },
      payload: { fields: validFields },
    })
    expect(res.statusCode).toBe(404)
    expect(writes).toHaveLength(0)
  })

  it('ohne canWrite/getUserProvider konfiguriert bleibt PUT unregistriert (404 Route-nicht-gefunden)', async () => {
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('onRequest', async (req) => {
      req.user = { id: 'writer', email: 'writer@test.local', displayName: 'writer' }
    })
    const { provider } = makeWritableProvider(undefined)
    registerMetadataSchemaRoutes(app, {
      spaces: [space],
      providerRegistry: () => provider,
      access: { canRead: async () => true },
      // canWrite/getUserProvider bewusst NICHT gesetzt.
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${space.id}/metadata-schema`,
      payload: { fields: validFields },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
