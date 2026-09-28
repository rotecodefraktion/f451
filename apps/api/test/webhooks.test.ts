import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { ForgejoProvider, NotFoundError, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { edges, locks, pages, users } from '../src/db/schema.js'
import { indexDraftPage } from '../src/drafts/save.js'
import { indexSpace } from '../src/indexer/index-space.js'
import {
  normalizePullRequestEvent,
  normalizePushEvent,
  type WebhookCleanupResult,
  type WebhookIndexResult,
} from '../src/routes/webhooks.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const FORGEJO_SECRET = 'forgejo-webhook-secret'
const GITHUB_SECRET = 'github-webhook-secret'

function signGitHub(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

function signForgejo(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Baut ein minimales, GitHub-/Forgejo-kompatibles Push-Payload. */
function pushPayload(opts: {
  owner: string
  repo: string
  branch?: string
  added?: string[]
  modified?: string[]
  removed?: string[]
}): string {
  return JSON.stringify({
    ref: `refs/heads/${opts.branch ?? 'main'}`,
    repository: { name: opts.repo, owner: { login: opts.owner } },
    commits: [
      {
        added: opts.added ?? [],
        modified: opts.modified ?? [],
        removed: opts.removed ?? [],
      },
    ],
  })
}

async function write(provider: ForgejoProvider, repo: RepoRef, path: string, content: string): Promise<void> {
  await provider.writeFile(repo, path, content, { branch: 'main', message: `seed: ${path}` })
}

/** Baut ein minimales `pull_request`-Payload (Phase 2d Task 2, GitHub-/Forgejo-
 *  Form, siehe Kommentar bei `normalizePullRequestEvent`). */
function pullRequestPayload(opts: {
  owner: string
  repo: string
  action: string
  merged: boolean
  head: string
  base?: string
  number?: number
}): string {
  return JSON.stringify({
    action: opts.action,
    number: opts.number ?? 1,
    pull_request: {
      number: opts.number ?? 1,
      merged: opts.merged,
      head: { ref: opts.head },
      base: { ref: opts.base ?? 'main' },
    },
    repository: { name: opts.repo, owner: { login: opts.owner } },
  })
}

describe('normalizePushEvent (reine Normalisierung)', () => {
  it('aggregiert added/modified/removed über mehrere Commits und dedupliziert', () => {
    const result = normalizePushEvent({
      ref: 'refs/heads/main',
      repository: { name: 'betrieb', owner: { login: 'dev-docs' } },
      commits: [
        { added: ['a/index.md'], modified: [], removed: [] },
        { added: [], modified: ['a/index.md'], removed: [] },
        { added: [], modified: [], removed: ['b/index.md'] },
      ],
    })
    expect(result.owner).toBe('dev-docs')
    expect(result.repo).toBe('betrieb')
    expect(result.branch).toBe('main')
    expect(result.changedPaths).toEqual(['a/index.md'])
    expect(result.removedPaths).toEqual(['b/index.md'])
  })

  it('erkennt Nicht-main-Branches und Nicht-Branch-Refs', () => {
    expect(normalizePushEvent({ ref: 'refs/heads/dev' }).branch).toBe('dev')
    expect(normalizePushEvent({ ref: 'refs/tags/v1.0.0' }).branch).toBeNull()
  })

  it('Endzustand gewinnt: derselbe Pfad zuerst geändert, dann im selben Push entfernt', () => {
    const result = normalizePushEvent({
      ref: 'refs/heads/main',
      repository: { name: 'r', owner: { login: 'o' } },
      commits: [
        { added: ['x/index.md'], modified: [], removed: [] },
        { added: [], modified: [], removed: ['x/index.md'] },
      ],
    })
    expect(result.changedPaths).toEqual([])
    expect(result.removedPaths).toEqual(['x/index.md'])
  })
})

/**
 * `normalizePullRequestEvent` (Phase 2d Task 2, reine Normalisierung): Payload-
 * Form ist die GitHub-`pull_request`-Webhook-Form (`action`, `pull_request.merged`,
 * `pull_request.head.ref`, `pull_request.base.ref`, `repository.owner.login`),
 * die laut Gitea-/Forgejo-API-Struktur (`api.PullRequestPayload`) identisch
 * gespiegelt wird — ANGENOMMENE Form, hier NUR mit von Hand gebauten Payloads
 * geprüft (kein Forgejo-Testcontainer-`pull_request`-Webhook verfügbar; der
 * Integrationstest unten schickt daher ebenfalls handgebaute, aber realistisch
 * signierte Payloads gegen die echte Route — die Provider-Interaktion danach
 * [`cleanupMergedDraft`] läuft trotzdem gegen den echten Forgejo-Container).
 */
describe('normalizePullRequestEvent (reine Normalisierung)', () => {
  it('gemergter, geschlossener PR → merged:true, Head-/Base-Branch extrahiert', () => {
    const result = normalizePullRequestEvent({
      action: 'closed',
      pull_request: { merged: true, head: { ref: 'draft/home' }, base: { ref: 'main' } },
      repository: { name: 'betrieb', owner: { login: 'dev-docs' } },
    })
    expect(result).toEqual({ owner: 'dev-docs', repo: 'betrieb', merged: true, headBranch: 'draft/home', baseBranch: 'main' })
  })

  it('geschlossen ohne Merge (abgelehnter PR) → merged:false', () => {
    const result = normalizePullRequestEvent({
      action: 'closed',
      pull_request: { merged: false, head: { ref: 'draft/home' }, base: { ref: 'main' } },
      repository: { name: 'betrieb', owner: { login: 'dev-docs' } },
    })
    expect(result.merged).toBe(false)
  })

  it('offener PR (action:"opened") → merged:false, unabhängig vom merged-Feld', () => {
    const result = normalizePullRequestEvent({
      action: 'opened',
      pull_request: { merged: false, head: { ref: 'draft/home' }, base: { ref: 'main' } },
      repository: { name: 'betrieb', owner: { login: 'dev-docs' } },
    })
    expect(result.merged).toBe(false)
  })
})

describe.sequential('POST /webhooks/forgejo + /webhooks/github (Signaturprüfung + inkrementelles Indexieren)', () => {
  let pgInstance: PgTestInstance
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

  // Phase 2d Task 2: analoger Wait-Helfer für den asynchron angestoßenen
  // Nach-Merge-Cleanup eines `pull_request`-Events (`onCleanup`-Test-Hook).
  let resolveCleanup: ((result: WebhookCleanupResult) => void) | null = null
  function nextCleanup(): Promise<WebhookCleanupResult> {
    return new Promise((resolve) => {
      resolveCleanup = resolve
    })
  }

  // F1-Regression: wenn gesetzt, wirft das readFile des vom Webhook genutzten
  // Providers für genau diesen Pfad genau einmal (simulierter transienter IO-Fehler).
  let failReadOncePath: string | null = null

  /** Delegiert alle Methoden an den echten Provider; readFile wirft einmalig für `failReadOncePath`. */
  function flakyProvider(inner: ForgejoProvider): GitProvider {
    return {
      readFile: async (r, path, ref) => {
        if (failReadOncePath === path) {
          failReadOncePath = null
          throw new Error('simulated transient IO error')
        }
        return inner.readFile(r, path, ref)
      },
      readFileBinary: (r, path, ref) => inner.readFileBinary(r, path, ref),
      listTree: (r, ref) => inner.listTree(r, ref),
      getHeadSha: (r, branch) => inner.getHeadSha(r, branch),
      writeFile: (r, path, content, opts) => inner.writeFile(r, path, content, opts),
      writeFileBinary: (r, path, content, opts) => inner.writeFileBinary(r, path, content, opts),
      createBranch: (r, name, fromBranch) => inner.createBranch(r, name, fromBranch),
      deleteBranch: (r, name) => inner.deleteBranch(r, name),
      listCommits: (r, opts) => inner.listCommits(r, opts),
      createPullRequest: (r, opts) => inner.createPullRequest(r, opts),
      getPullRequest: (r, number) => inner.getPullRequest(r, number),
      mergePullRequest: (r, number) => inner.mergePullRequest(r, number),
    }
  }

  beforeAll(async () => {
    ;[pgInstance, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pgInstance.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('webhooks')

    space = {
      id: 'betrieb',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }

    // Webhooks setzen einen bereits indexierten Space voraus (der `spaces.id`
    // FK von `pages` erwartet die Zeile, die normalerweise ein initialer
    // Voll-Reindex — Task 5 Admin-Endpoint — anlegt). Leerer Reindex reicht.
    await indexSpace({ db, provider }, space)

    app = buildApp({
      databaseUrl: pgInstance.connectionString,
      spaces: [space],
      providerRegistry: () => flakyProvider(provider),
      webhookSecrets: { forgejo: FORGEJO_SECRET, github: GITHUB_SECRET },
      onIndexed: (result) => {
        resolveIndexed?.(result)
        resolveIndexed = null
      },
      onCleanup: (result) => {
        resolveCleanup?.(result)
        resolveCleanup = null
      },
    })
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pgInstance?.stop(), forgejo?.stop()])
  })

  it('Forgejo: fehlende Signatur → 401, keine Verarbeitung', async () => {
    const body = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })

  it('Forgejo: ungültige Signatur → 401, keine Verarbeitung', async () => {
    const body = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': 'deadbeef' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })

  it('Forgejo: gültige Signatur, unbekanntes Repo → 202 ignoriert', async () => {
    const body = pushPayload({ owner: repo.owner, repo: 'kein-space-hier', added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().status).toBe('ignored')
  })

  it('Forgejo: gültige Signatur, Nicht-main-Branch → 202 ignoriert', async () => {
    const body = pushPayload({ owner: repo.owner, repo: repo.repo, branch: 'dev', added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().status).toBe('ignored')
  })

  it('GitHub: fehlende Signatur → 401', async () => {
    const body = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })

  it('GitHub: ungültige Signatur → 401', async () => {
    const body = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })

  it('GitHub: gültige Signatur, unbekanntes Repo → 202 ignoriert (kein GitHub-Space konfiguriert)', async () => {
    const body = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['index.md'] })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signGitHub(GITHUB_SECRET, body) },
      payload: body,
    })
    // space ist als forgejo-Space konfiguriert → über den github-Provider nie ein Match.
    expect(res.statusCode).toBe(202)
    expect(res.json().status).toBe('ignored')
  })

  it('Push-Fixture → neue Seite im Index (Datei vorher committen, dann Webhook)', async () => {
    await write(
      provider,
      repo,
      'index.md',
      `---\nid: home\ntitle: Startseite\nlang: de\n---\n# Startseite\n\nText.\n`,
    )

    const body = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['index.md'] })
    // Regressionswächter (Final-Review 4a): ein ERFOLGREICHer Webhook darf
    // `webhook_errors` NICHT erhöhen — der Zähler steigt strukturell nur im
    // .catch von handlePush/cleanupAfterMerge (siehe routes/webhooks.ts).
    // Delta-basiert (statt absolut), damit der Test unabhängig von der
    // Ausführungsreihenfolge auf der geteilten `app`-Instanz bleibt.
    const errorsBefore = app.opsCounters.snapshot().webhookErrors
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
    if ('report' in result) {
      expect(result.report.pagesUpdated).toBe(1)
    }

    const homeRows = await db.select().from(pages).where(eq(pages.id, 'home'))
    expect(homeRows).toHaveLength(1)
    expect(homeRows[0]?.title).toBe('Startseite')
    expect(app.opsCounters.snapshot().webhookErrors).toBe(errorsBefore)
  }, 60_000)

  it('Broken-Link-Heilung: Seite A verlinkt fehlendes B → B wird gepusht → Kante zeigt auf B', async () => {
    await write(
      provider,
      repo,
      'a/index.md',
      `---\nid: a\ntitle: A\nlang: de\n---\n# A\n\nSiehe [[b]].\n`,
    )
    const bodyA = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['a/index.md'] })
    const waitingA = nextIndexed()
    await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyA) },
      payload: bodyA,
    })
    await waitingA

    const brokenBefore = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'a'), eq(edges.rawTarget, 'b'), eq(edges.type, 'link')))
    expect(brokenBefore).toHaveLength(1)
    expect(brokenBefore[0]?.toPageId).toBeNull()

    await write(provider, repo, 'b/index.md', `---\nid: b\ntitle: B\nlang: de\n---\n# B\n\nText B.\n`)
    const bodyB = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['b/index.md'] })
    const waitingB = nextIndexed()
    await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyB) },
      payload: bodyB,
    })
    const resultB = await waitingB
    expect('report' in resultB).toBe(true)
    if ('report' in resultB) {
      expect(resultB.report.brokenLinksHealed).toBeGreaterThanOrEqual(1)
    }

    const healed = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'a'), eq(edges.rawTarget, 'b'), eq(edges.type, 'link')))
    expect(healed[0]?.toPageId).toBe('b')

    const noLongerBroken = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromPageId, 'a'), isNull(edges.toPageId)))
    expect(noLongerBroken).toHaveLength(0)
  }, 60_000)

  it('removed → Seite verschwindet aus dem Index', async () => {
    const before = await db.select().from(pages).where(eq(pages.id, 'a'))
    expect(before).toHaveLength(1)

    const body = pushPayload({ owner: repo.owner, repo: repo.repo, removed: ['a/index.md'] })
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
    if ('report' in result) {
      expect(result.report.pagesRemoved).toBe(1)
    }

    const after = await db.select().from(pages).where(eq(pages.id, 'a'))
    expect(after).toHaveLength(0)

    // Die von A ausgehende Kante zu B ist mitgelöscht (CASCADE über fromPageId),
    // die eingehende hierarchy-Kante von b→home (falls vorhanden) bleibt unberührt.
    const fromA = await db.select().from(edges).where(eq(edges.fromPageId, 'a'))
    expect(fromA).toHaveLength(0)
  }, 60_000)

  it(
    'removed + gleichzeitig offener Draft (ref=draft) derselben Id → NUR die main-Zeile verschwindet, ' +
      'der Draft-Index bleibt stehen (Fix Review-Befund 1: der Delete im inkrementellen Indexer filterte ' +
      'bisher NICHT nach ref, sodass er beide Zeilen derselben Id getroffen hätte — Autor hätte den ' +
      'Entwurf still verloren)',
    async () => {
      const draftPageId = 'draft-survivor'
      const draftPagePath = 'draft-survivor/index.md'
      await write(
        provider,
        repo,
        draftPagePath,
        `---\nid: ${draftPageId}\ntitle: Draft Survivor\nlang: de\n---\n# Draft Survivor\n\nmain-inhalt\n`,
      )
      const bodyAdd = pushPayload({ owner: repo.owner, repo: repo.repo, added: [draftPagePath] })
      const waitingAdd = nextIndexed()
      await app.inject({
        method: 'POST',
        url: '/webhooks/forgejo',
        headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyAdd) },
        payload: bodyAdd,
      })
      await waitingAdd

      const mainBefore = await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, draftPageId), eq(pages.ref, 'main')))
      expect(mainBefore).toHaveLength(1)

      // Autor hat parallel einen Draft zu derselben Seite offen (ref='draft') —
      // dieselbe id, andere Zeile über den zusammengesetzten PK (id, ref).
      await indexDraftPage(
        db,
        space,
        draftPageId,
        draftPagePath,
        `---\nid: ${draftPageId}\ntitle: Draft Survivor\nlang: de\n---\n# Draft Survivor\n\nentwurf-inhalt\n`,
      )
      const draftBefore = await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, draftPageId), eq(pages.ref, 'draft')))
      expect(draftBefore).toHaveLength(1)

      // main-Seite wird auf main gelöscht (Datei entfernt) — der Webhook feuert
      // und der inkrementelle Indexer räumt die entfernte main-Zeile weg.
      const bodyRemove = pushPayload({ owner: repo.owner, repo: repo.repo, removed: [draftPagePath] })
      const waitingRemove = nextIndexed()
      await app.inject({
        method: 'POST',
        url: '/webhooks/forgejo',
        headers: {
          'content-type': 'application/json',
          'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyRemove),
        },
        payload: bodyRemove,
      })
      await waitingRemove

      const mainAfter = await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, draftPageId), eq(pages.ref, 'main')))
      expect(mainAfter).toHaveLength(0)

      // Der Draft-Index-Eintrag derselben id darf NICHT mitgelöscht worden sein.
      const draftAfter = await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, draftPageId), eq(pages.ref, 'draft')))
      expect(draftAfter).toHaveLength(1)
      expect(draftAfter[0]?.plainText).toContain('entwurf-inhalt')
    },
    60_000,
  )

  it('transienter readFile-Fehler → Datei übersprungen (alter Inhalt bleibt), zweiter Webhook heilt (F1)', async () => {
    // Seite mit Ausgangsinhalt anlegen und normal per Webhook indexieren.
    await write(
      provider,
      repo,
      'c/index.md',
      `---\nid: c\ntitle: C\nlang: de\n---\n# C\n\nVersion 1.\n`,
    )
    const bodyAdd = pushPayload({ owner: repo.owner, repo: repo.repo, added: ['c/index.md'] })
    const waitingAdd = nextIndexed()
    await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyAdd) },
      payload: bodyAdd,
    })
    await waitingAdd

    const before = (await db.select().from(pages).where(eq(pages.id, 'c')))[0]!
    expect(before.plainText).toContain('Version 1')

    // Neue Version committen; der nächste Webhook-Lauf scheitert beim Lesen einmalig.
    const file = await provider.readFile(repo, 'c/index.md', 'main')
    await provider.writeFile(
      repo,
      'c/index.md',
      `---\nid: c\ntitle: C\nlang: de\n---\n# C\n\nVersion 2.\n`,
      { branch: 'main', message: 'update c', sha: file.sha },
    )
    failReadOncePath = 'c/index.md'

    const bodyMod = pushPayload({ owner: repo.owner, repo: repo.repo, modified: ['c/index.md'] })
    const waitingFail = nextIndexed()
    await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyMod) },
      payload: bodyMod,
    })
    const failResult = await waitingFail

    // Datei wurde übersprungen und gezählt — NICHT als leere Seite upsertet.
    expect('report' in failResult).toBe(true)
    if ('report' in failResult) {
      expect(failResult.report.filesSkippedIo).toBe(1)
      expect(failResult.report.pagesUpdated).toBe(0)
    }
    const afterFail = (await db.select().from(pages).where(eq(pages.id, 'c')))[0]!
    // Seite bleibt UNVERÄNDERT mit altem Inhalt (inkl. updatedAt) — kein stiller Datenverlust.
    expect(afterFail).toEqual(before)

    // Zweiter Webhook ohne Fehler → Version 2 im Index.
    const waitingHeal = nextIndexed()
    await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, bodyMod) },
      payload: bodyMod,
    })
    const healResult = await waitingHeal
    expect('report' in healResult).toBe(true)
    if ('report' in healResult) {
      expect(healResult.report.filesSkippedIo).toBe(0)
      expect(healResult.report.pagesUpdated).toBe(1)
    }
    const healed = (await db.select().from(pages).where(eq(pages.id, 'c')))[0]!
    expect(healed.plainText).toContain('Version 2')
  }, 60_000)

  it(
    'echter Fehlerpfad (Task 5, Betrieb): Space ohne vorherigen Voll-Reindex (spaces-Zeile fehlt in der DB) ' +
      '→ der Push-Webhook löst beim Upsert eine ECHTE Fremdschlüssel-Verletzung aus (kein simulierter Fehler ' +
      'wie beim F1-Test oben) → landet im .catch von handlePush → opsCounters.webhookErrors erhöht sich um 1',
    async () => {
      const errorRepo = await forgejo.createRepo('webhooks-error-space')
      const errorSpace: SpaceConfig = {
        id: 'webhooks-error-space',
        name: 'Fehler-Space',
        provider: 'forgejo',
        owner: errorRepo.owner,
        repo: errorRepo.repo,
        defaultLang: 'de',
        repoRef: errorRepo,
      }
      // WICHTIG: bewusst KEIN `indexSpace(...)`-Aufruf hier (anders als beim
      // `beforeAll` oben) — die `spaces`-Zeile fehlt daher in der DB, und der
      // `pages.space_id`-Fremdschlüssel schlägt beim Upsert durch den Webhook
      // fehl.
      await write(provider, errorRepo, 'index.md', `---\nid: err\ntitle: Fehler\nlang: de\n---\n# Fehler\n\nText.\n`)

      let resolveError: ((result: WebhookIndexResult) => void) | null = null
      const waitingError = new Promise<WebhookIndexResult>((resolve) => {
        resolveError = resolve
      })
      const errorApp = buildApp({
        databaseUrl: pgInstance.connectionString,
        spaces: [errorSpace],
        providerRegistry: () => provider,
        webhookSecrets: { forgejo: FORGEJO_SECRET, github: GITHUB_SECRET },
        onIndexed: (result) => resolveError?.(result),
      })

      expect(errorApp.opsCounters.snapshot().webhookErrors).toBe(0)

      const body = pushPayload({ owner: errorRepo.owner, repo: errorRepo.repo, added: ['index.md'] })
      const res = await errorApp.inject({
        method: 'POST',
        url: '/webhooks/forgejo',
        headers: { 'content-type': 'application/json', 'x-gitea-signature': signForgejo(FORGEJO_SECRET, body) },
        payload: body,
      })
      expect(res.statusCode).toBe(202)

      const result = await waitingError
      expect('error' in result).toBe(true)

      expect(errorApp.opsCounters.snapshot().webhookErrors).toBe(1)
      await errorApp.close()
    },
    60_000,
  )

  describe(
    'pull_request-Event (Phase 2d Task 2): Nach-Merge-Cleanup, nicht-merged ignoriert, Event-Header-Dispatch',
    () => {
      it(
        'merged=true, Head=Draft-Branch, Base=main → 202 accepted + cleanupMergedDraft ' +
          '(Branch/Draft-Index/Lock weg, main-Zeile bleibt — das Neu-Rendern übernimmt der push-Webhook)',
        async () => {
          const wfPageId = 'wf-cleanup-page'
          const wfBranch = draftBranchName(wfPageId)
          await provider.createBranch(repo, wfBranch, 'main')
          await db.insert(users).values({ id: 'wf-user', email: 'wf-user@test.local', displayName: 'WF User' })
          // `locks.(pageId, ref='main')` hat eine FK auf `pages.(id, ref)` — die
          // main-Zeile muss also existieren, bevor der Lock angelegt werden kann.
          await db.insert(pages).values([
            { id: wfPageId, spaceId: space.id, path: 'wf-cleanup-page.md', ref: 'main', title: 'WF', lang: 'de' },
            { id: wfPageId, spaceId: space.id, path: 'wf-cleanup-page.md', ref: 'draft', title: 'WF', lang: 'de' },
          ])
          await db.insert(locks).values({
            pageId: wfPageId, userId: 'wf-user', userName: 'WF User', heartbeatAt: new Date(),
          })

          const body = pullRequestPayload({
            owner: repo.owner, repo: repo.repo, action: 'closed', merged: true, head: wfBranch, base: 'main',
          })
          const waiting = nextCleanup()
          const res = await app.inject({
            method: 'POST',
            url: '/webhooks/forgejo',
            headers: {
              'content-type': 'application/json',
              'x-gitea-signature': signForgejo(FORGEJO_SECRET, body),
              'x-gitea-event': 'pull_request',
            },
            payload: body,
          })
          expect(res.statusCode).toBe(202)
          expect(res.json().status).toBe('accepted')

          const result = await waiting
          expect('error' in result).toBe(false)
          expect(result.pageId).toBe(wfPageId)

          await expect(provider.getHeadSha(repo, wfBranch)).rejects.toBeInstanceOf(NotFoundError)
          const draftRows = await db
            .select()
            .from(pages)
            .where(and(eq(pages.id, wfPageId), eq(pages.ref, 'draft')))
          expect(draftRows).toHaveLength(0)
          const lockRows = await db.select().from(locks).where(eq(locks.pageId, wfPageId))
          expect(lockRows).toHaveLength(0)
          // main-Zeile bleibt unangetastet — dieser Handler indexiert nicht neu,
          // das übernimmt der ohnehin eintreffende push-auf-main-Webhook.
          const mainRows = await db
            .select()
            .from(pages)
            .where(and(eq(pages.id, wfPageId), eq(pages.ref, 'main')))
          expect(mainRows).toHaveLength(1)
        },
        60_000,
      )

      it(
        'merged=true, Head-Branch mit Hash-Suffix (path:-Fallback-Id OHNE Frontmatter-id — der ' +
          'NORMALFALL für Seiten ohne explizite id, siehe branch-name.ts/index-space.ts) → ' +
          'Rückwärts-Suche über die offenen Drafts findet die echte pageId, Draft-Index-Zeile ' +
          'UND Lock werden trotz sanitisiertem, hash-suffigiertem Branch-Namen korrekt aufgeräumt ' +
          '(Regressionstest zum Important-Review-Befund: naives Branch-Namen-Stripping verfehlte ' +
          'diesen — häufigsten — Fall bisher, weil der Hash-Suffix irreversibel ist)',
        async () => {
          const hashPageId = `path:${space.id}/hash-fallback/index.md`
          const hashBranch = draftBranchName(hashPageId)
          // Beweist die Prämisse des Tests: Die Id enthält git-unsichere Zeichen (':', '/'),
          // der Branch-Name trägt also tatsächlich einen Hash-Suffix statt der reinen pageId.
          expect(hashBranch).not.toBe(`draft/${hashPageId}`)

          await provider.createBranch(repo, hashBranch, 'main')
          await db.insert(users).values({
            id: 'wf-hash-user', email: 'wf-hash-user@test.local', displayName: 'WF Hash User',
          })
          await db.insert(pages).values([
            {
              id: hashPageId, spaceId: space.id, path: 'hash-fallback/index.md', ref: 'main',
              title: 'Hash Fallback', lang: 'de',
            },
            {
              id: hashPageId, spaceId: space.id, path: 'hash-fallback/index.md', ref: 'draft',
              title: 'Hash Fallback', lang: 'de',
            },
          ])
          await db.insert(locks).values({
            pageId: hashPageId, userId: 'wf-hash-user', userName: 'WF Hash User', heartbeatAt: new Date(),
          })

          const body = pullRequestPayload({
            owner: repo.owner, repo: repo.repo, action: 'closed', merged: true, head: hashBranch, base: 'main',
          })
          const waiting = nextCleanup()
          const res = await app.inject({
            method: 'POST',
            url: '/webhooks/forgejo',
            headers: {
              'content-type': 'application/json',
              'x-gitea-signature': signForgejo(FORGEJO_SECRET, body),
              'x-gitea-event': 'pull_request',
            },
            payload: body,
          })
          expect(res.statusCode).toBe(202)
          expect(res.json().status).toBe('accepted')

          const result = await waiting
          expect('error' in result).toBe(false)
          expect(result.pageId).toBe(hashPageId)

          await expect(provider.getHeadSha(repo, hashBranch)).rejects.toBeInstanceOf(NotFoundError)
          const draftRows = await db
            .select()
            .from(pages)
            .where(and(eq(pages.id, hashPageId), eq(pages.ref, 'draft')))
          expect(draftRows).toHaveLength(0)
          const lockRows = await db.select().from(locks).where(eq(locks.pageId, hashPageId))
          expect(lockRows).toHaveLength(0)
          const mainRows = await db
            .select()
            .from(pages)
            .where(and(eq(pages.id, hashPageId), eq(pages.ref, 'main')))
          expect(mainRows).toHaveLength(1)
        },
        60_000,
      )

      it(
        'merged=true, Head-Branch sieht wie ein Draft-Branch aus, aber keine offene Draft-Zeile/' +
          'kein Lock passt dazu (Rückwärts-Suche ohne Treffer, z. B. Retry nach bereits erfolgtem ' +
          'Cleanup) → nur Branch-Cleanup (Branch ist ggf. schon weg), kein Fehler',
        async () => {
          const orphanBranch = 'draft/orphan-no-db-match'
          await provider.createBranch(repo, orphanBranch, 'main')

          const body = pullRequestPayload({
            owner: repo.owner, repo: repo.repo, action: 'closed', merged: true, head: orphanBranch, base: 'main',
          })
          const waiting = nextCleanup()
          const res = await app.inject({
            method: 'POST',
            url: '/webhooks/forgejo',
            headers: {
              'content-type': 'application/json',
              'x-gitea-signature': signForgejo(FORGEJO_SECRET, body),
              'x-gitea-event': 'pull_request',
            },
            payload: body,
          })
          expect(res.statusCode).toBe(202)
          expect(res.json().status).toBe('accepted')

          const result = await waiting
          expect('error' in result).toBe(false)
          expect(result.pageId).toBeNull()

          await expect(provider.getHeadSha(repo, orphanBranch)).rejects.toBeInstanceOf(NotFoundError)
        },
      )

      it(
        'merged=false (abgelehnter PR) → 202 ignoriert, Draft-Branch/-Index bleiben unangetastet ' +
          '(Autor kann weiterarbeiten)',
        async () => {
          const rejectedPageId = 'wf-rejected-page'
          const rejectedBranch = draftBranchName(rejectedPageId)
          await provider.createBranch(repo, rejectedBranch, 'main')
          await db.insert(pages).values([
            {
              id: rejectedPageId, spaceId: space.id, path: 'wf-rejected-page.md', ref: 'main',
              title: 'Rejected', lang: 'de',
            },
            {
              id: rejectedPageId, spaceId: space.id, path: 'wf-rejected-page.md', ref: 'draft',
              title: 'Rejected', lang: 'de',
            },
          ])

          const body = pullRequestPayload({
            owner: repo.owner, repo: repo.repo, action: 'closed', merged: false,
            head: rejectedBranch, base: 'main',
          })
          const res = await app.inject({
            method: 'POST',
            url: '/webhooks/forgejo',
            headers: {
              'content-type': 'application/json',
              'x-gitea-signature': signForgejo(FORGEJO_SECRET, body),
              'x-gitea-event': 'pull_request',
            },
            payload: body,
          })
          expect(res.statusCode).toBe(202)
          expect(res.json().status).toBe('ignored')

          expect(await provider.getHeadSha(repo, rejectedBranch)).toMatch(/^[0-9a-f]{40}$/)
          const draftRows = await db
            .select()
            .from(pages)
            .where(and(eq(pages.id, rejectedPageId), eq(pages.ref, 'draft')))
          expect(draftRows).toHaveLength(1)

          await provider.deleteBranch(repo, rejectedBranch)
        },
      )

      it(
        'GitHub: X-GitHub-Event: pull_request, gültige Signatur, unbekanntes Repo (Space ist als ' +
          'forgejo konfiguriert) → 202 ignoriert — beweist den Event-Header-Dispatch auf der ' +
          'GitHub-Route (Payload-Form laut GitHub-Doku, siehe normalizePullRequestEvent-Kommentar)',
        async () => {
          const body = pullRequestPayload({
            owner: repo.owner, repo: repo.repo, action: 'closed', merged: true,
            head: 'draft/irrelevant', base: 'main',
          })
          const res = await app.inject({
            method: 'POST',
            url: '/webhooks/github',
            headers: {
              'content-type': 'application/json',
              'x-hub-signature-256': signGitHub(GITHUB_SECRET, body),
              'x-github-event': 'pull_request',
            },
            payload: body,
          })
          expect(res.statusCode).toBe(202)
          expect(res.json().status).toBe('ignored')
        },
      )

      it('falsche Signatur bei pull_request-Event → 401, keine Verarbeitung (HMAC-Prüfung unverändert)', async () => {
        const body = pullRequestPayload({
          owner: repo.owner, repo: repo.repo, action: 'closed', merged: true,
          head: 'draft/irrelevant', base: 'main',
        })
        const res = await app.inject({
          method: 'POST',
          url: '/webhooks/forgejo',
          headers: {
            'content-type': 'application/json',
            'x-gitea-signature': 'deadbeef',
            'x-gitea-event': 'pull_request',
          },
          payload: body,
        })
        expect(res.statusCode).toBe(401)
      })
    },
  )
})
