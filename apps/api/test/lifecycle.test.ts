import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { edges, pages, spaces as spacesTable, tags } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { WebhookIndexResult } from '../src/routes/webhooks.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const FORGEJO_SECRET = 'lifecycle-forgejo-secret'
const ADMIN_TOKEN = 'lifecycle-admin-token'

function signForgejo(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Baut ein minimales, Forgejo-kompatibles Push-Payload (main-Branch). */
function pushPayload(opts: {
  owner: string
  repo: string
  added?: string[]
  modified?: string[]
  removed?: string[]
}): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    repository: { name: opts.repo, owner: { login: opts.owner } },
    commits: [{ added: opts.added ?? [], modified: opts.modified ?? [], removed: opts.removed ?? [] }],
  })
}

/** Legt eine Datei an (kein `sha`) oder aktualisiert sie (`sha` des bekannten
 *  Standes, sonst lehnt Forgejo mit 422 ab — konfliktsichere Updates). */
async function write(provider: ForgejoProvider, repo: RepoRef, path: string, content: string, sha?: string): Promise<void> {
  await provider.writeFile(repo, path, content, { branch: 'main', message: `lifecycle: ${path}`, sha })
}

/** Pfadsegmente einzeln encoden, Slashes erhalten (wie `ForgejoProvider` intern). */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

/**
 * Löscht eine Datei über die rohe Forgejo-Contents-API. `GitProvider` kennt
 * bewusst keine `deleteFile`-Methode (Plan Task 1a: kein Schreibpfad in Phase 1c
 * außer dem Indexer selbst) — dieser Helper simuliert nur die EXTERNE Löschung
 * einer Wiki-Seite direkt im Git-Repo, wie sie im echten Betrieb über die
 * Forgejo-Weboberfläche oder einen anderen Git-Client passieren würde.
 */
async function deleteFile(forgejo: ForgejoTestInstance, repo: RepoRef, path: string, sha: string): Promise<void> {
  const res = await fetch(`${forgejo.baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${forgejo.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'main', message: `lifecycle: delete ${path}`, sha }),
  })
  if (!res.ok) throw new Error(`Löschen von "${path}" fehlgeschlagen (${res.status}): ${await res.text()}`)
}

/**
 * Task 7 — Ein durchgehender Test, der das Zusammenspiel ALLER Phase-1c-Module
 * gegen echte PG-/Forgejo-Testcontainer beweist (Spec „Draft anlegen → … →
 * Leseansicht" in der 1c-Ausbaustufe, Plan-Abnahme 1–4):
 *
 *   Repo seeden → indexSpace → Seite per API lesbar (+Tree)
 *   → Datei extern ändern + Webhook (echte Forgejo-HMAC) → Seite aktualisiert
 *   → Datei löschen + Webhook (echte Forgejo-HMAC) → 404
 *   → Wegwerfbarkeits-Beweis: alle Index-Tabellen leeren → POST /admin/reindex
 *     → identischer Zustand (Zeilenzählungen + inhaltliche Stichprobe)
 *
 * Ein einziger `beforeAll` baut EINE App/DB/Forgejo-Instanz auf, die alle
 * `it`-Blöcke sequenziell (voneinander abhängig) durchlaufen — bewusst kein
 * Reset zwischen den Schritten, weil genau die Lebenszyklus-Kette (nicht
 * isolierte Einzel-Assertions) das Abnahmekriterium ist.
 */
describe.sequential('Task 7: End-to-End-Lifecycle (Index → Webhook → Lese-API) + Wegwerfbarkeit', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: ReturnType<typeof buildApp>

  let resolveIndexed: ((result: WebhookIndexResult) => void) | null = null
  function nextIndexed(): Promise<WebhookIndexResult> {
    return new Promise((resolve) => {
      resolveIndexed = resolve
    })
  }

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('lifecycle')

    // 1. Repo seeden: kleiner, aber realistischer Baum — Hierarchie (home →
    //    betrieb → monitoring), Wikilink, relativer Link, kaputter Link,
    //    Relation und Tags, damit die Wegwerfbarkeits-Zählungen später nicht
    //    trivial (0/1) sind.
    await write(
      provider,
      repo,
      'index.md',
      '---\nid: home\ntitle: Startseite\nlang: de\ntags: [start]\n---\n'
        + '# Startseite\n\nSiehe [[betrieb]] und den fehlenden [[gibt-es-nicht]].\n',
    )
    await write(
      provider,
      repo,
      'betrieb/index.md',
      '---\nid: betrieb\ntitle: Betrieb\nlang: de\ntags: [betrieb]\n'
        + 'relations:\n  depends_on:\n    - monitoring\n---\n'
        + '# Betrieb\n\nZum [Monitoring](./monitoring/index.md) siehe dort.\n',
    )
    await write(
      provider,
      repo,
      'betrieb/monitoring/index.md',
      '---\nid: monitoring\ntitle: Monitoring\nlang: de\ntags: [ops]\n---\n# Monitoring\n\nVersion 1.\n',
    )

    space = {
      id: 'lifecycle',
      name: 'Lifecycle',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    // 2. indexSpace: initialer Voll-Reindex (füllt den anfangs leeren Cache).
    await indexSpace({ db, provider }, space)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      webhookSecrets: { forgejo: FORGEJO_SECRET },
      adminToken: ADMIN_TOKEN,
      onIndexed: (result) => {
        resolveIndexed?.(result)
        resolveIndexed = null
      },
    })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('Seite ist nach dem Voll-Reindex per API lesbar (Page + Tree)', async () => {
    const pageRes = await app.inject({ method: 'GET', url: '/api/pages/monitoring' })
    expect(pageRes.statusCode).toBe(200)
    const page = pageRes.json()
    expect(page.title).toBe('Monitoring')
    expect(page.html).toContain('Version 1')
    expect(page.tags).toEqual(['ops'])

    const treeRes = await app.inject({ method: 'GET', url: '/api/spaces/lifecycle/tree' })
    expect(treeRes.statusCode).toBe(200)
    const tree = treeRes.json()
    // home (einzige Wurzel) → betrieb → monitoring.
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('home')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].id).toBe('betrieb')
    expect(tree[0].children[0].children[0].id).toBe('monitoring')
  })

  it('Datei extern geändert + Webhook (echte Forgejo-HMAC) → Seite per API aktualisiert', async () => {
    const current = await provider.readFile(repo, 'betrieb/monitoring/index.md', 'main')
    await write(
      provider,
      repo,
      'betrieb/monitoring/index.md',
      '---\nid: monitoring\ntitle: Monitoring\nlang: de\ntags: [ops]\n---\n'
        + '# Monitoring\n\nVersion 2 — extern geändert.\n',
      current.sha,
    )

    const body = pushPayload({ owner: repo.owner, repo: repo.repo, modified: ['betrieb/monitoring/index.md'] })
    const waiting = nextIndexed()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(202)

    const result = await waiting
    expect('report' in result).toBe(true)
    if ('report' in result) expect(result.report.pagesUpdated).toBe(1)

    const pageRes = await app.inject({ method: 'GET', url: '/api/pages/monitoring' })
    expect(pageRes.statusCode).toBe(200)
    expect(pageRes.json().html).toContain('Version 2 — extern geändert')
  }, 60_000)

  it('Datei gelöscht + Webhook (echte Forgejo-HMAC) → Seite verschwindet aus der API (404)', async () => {
    const file = await provider.readFile(repo, 'betrieb/monitoring/index.md', 'main')
    await deleteFile(forgejo, repo, 'betrieb/monitoring/index.md', file.sha)

    const body = pushPayload({ owner: repo.owner, repo: repo.repo, removed: ['betrieb/monitoring/index.md'] })
    const waiting = nextIndexed()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(202)

    const result = await waiting
    expect('report' in result).toBe(true)
    if ('report' in result) expect(result.report.pagesRemoved).toBe(1)

    const pageRes = await app.inject({ method: 'GET', url: '/api/pages/monitoring' })
    expect(pageRes.statusCode).toBe(404)
  }, 60_000)

  it(
    'Wegwerfbarkeits-Beweis: alle Index-Tabellen leeren → POST /admin/reindex stellt identischen Zustand wieder her',
    async () => {
      // Zustand VOR dem Leeren einfangen: Zeilenzählungen (Seiten/Kanten/Tags
      // des Space) und eine inhaltliche Stichprobe über die Lese-API (Page +
      // Tree) — dynamisch ermittelt, nicht hartkodiert, damit der Test robust
      // gegen Details des Fixtures bleibt.
      const pagesBefore = await db.select().from(pages).where(eq(pages.spaceId, space.id))
      const edgesBefore = await db
        .select({ fromPageId: edges.fromPageId })
        .from(edges)
        .innerJoin(pages, eq(edges.fromPageId, pages.id))
        .where(eq(pages.spaceId, space.id))
      const tagsBefore = await db
        .select({ pageId: tags.pageId })
        .from(tags)
        .innerJoin(pages, eq(tags.pageId, pages.id))
        .where(eq(pages.spaceId, space.id))

      expect(pagesBefore.length).toBeGreaterThan(0)
      expect(edgesBefore.length).toBeGreaterThan(0)
      expect(tagsBefore.length).toBeGreaterThan(0)

      const homeBefore = (await app.inject({ method: 'GET', url: '/api/pages/home' })).json()
      const treeBefore = (await app.inject({ method: 'GET', url: '/api/spaces/lifecycle/tree' })).json()

      // Alle Index-Tabellen leeren — in FK-sicherer Reihenfolge (Kinder vor
      // Eltern), auch wenn CASCADE dasselbe täte: der Beweis soll explizit
      // zeigen, dass wirklich NICHTS in Postgres übrig bleibt (Der Index ist
      // Cache, Plan Global Constraints).
      await db.delete(edges)
      await db.delete(tags)
      await db.delete(pages)
      await db.delete(spacesTable)

      expect(await db.select().from(pages)).toHaveLength(0)
      expect(await db.select().from(edges)).toHaveLength(0)
      expect(await db.select().from(tags)).toHaveLength(0)
      expect(await db.select().from(spacesTable)).toHaveLength(0)

      // Wiederherstellung AUSSCHLIESSLICH über den Admin-Reindex-Endpunkt —
      // kein direkter Aufruf von `indexSpace` hier, das ist der Betriebsweg.
      const reindexRes = await app.inject({
        method: 'POST',
        url: '/admin/reindex',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { space: space.id },
      })
      expect(reindexRes.statusCode).toBe(200)
      const reindexBody = reindexRes.json() as Array<Record<string, unknown>>
      expect(reindexBody).toHaveLength(1)
      expect(reindexBody[0]?.space).toBe(space.id)
      expect('report' in reindexBody[0]!).toBe(true)

      const pagesAfter = await db.select().from(pages).where(eq(pages.spaceId, space.id))
      const edgesAfter = await db
        .select({ fromPageId: edges.fromPageId })
        .from(edges)
        .innerJoin(pages, eq(edges.fromPageId, pages.id))
        .where(eq(pages.spaceId, space.id))
      const tagsAfter = await db
        .select({ pageId: tags.pageId })
        .from(tags)
        .innerJoin(pages, eq(tags.pageId, pages.id))
        .where(eq(pages.spaceId, space.id))

      // Zeilenzählungen identisch zum Stand vor dem Leeren.
      expect(pagesAfter).toHaveLength(pagesBefore.length)
      expect(edgesAfter).toHaveLength(edgesBefore.length)
      expect(tagsAfter).toHaveLength(tagsBefore.length)
      expect(new Set(pagesAfter.map((p) => p.id))).toEqual(new Set(pagesBefore.map((p) => p.id)))

      // Inhaltliche Stichprobe über die Lese-API: identisch bis auf `updatedAt`
      // (das Idempotenz-Vertrag aus Task 3 explizit als einzige erlaubte
      // Abweichung nennt).
      const homeAfter = (await app.inject({ method: 'GET', url: '/api/pages/home' })).json()
      expect({ ...homeAfter, updatedAt: undefined }).toEqual({ ...homeBefore, updatedAt: undefined })

      const treeAfter = (await app.inject({ method: 'GET', url: '/api/spaces/lifecycle/tree' })).json()
      expect(treeAfter).toEqual(treeBefore)
    },
    60_000,
  )

  it('/admin/reindex erscheint in der OpenAPI-Spec unter Tag "admin" (Task-7-Härtung)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json()
    expect(spec.paths['/admin/reindex']).toBeDefined()
    expect(spec.paths['/admin/reindex'].post.tags).toContain('admin')
  })
})
