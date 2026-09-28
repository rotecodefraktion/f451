import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ForgejoProvider, NotFoundError, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { draftBranchName } from '../src/drafts/branch-name.js'
import {
  cleanupMergedDraft,
  clearDraftIndex,
  createOrGetDraft,
  discardDraft,
  getDraft,
  getDraftState,
  getWorkflowState,
  type DraftLifecycleDeps,
} from '../src/drafts/lifecycle.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Draft-Lifecycle (Phase 2a Task 2): `createOrGetDraft`/`getDraft`/
 * `discardDraft`/`getDraftState` gegen einen echten Forgejo-Container —
 * unabhängig von der HTTP-Schicht (die Routen-Verdrahtung inkl. Berechtigungs-
 * Gates ist in `drafts-routes.test.ts` abgedeckt).
 */
describe.sequential('Draft-Lifecycle (Phase 2a Task 2)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let deps: DraftLifecycleDeps

  const pageId = 'home'
  const pagePath = 'index.md'
  const branch = draftBranchName(pageId)
  // Anfragende userId für createOrGetDraft/getDraft (Task 1: `loadFreshLock`
  // bekommt sie zur `mine`-Berechnung) — dieser Test prüft primär den
  // Lifecycle, nicht die `mine`-Logik selbst (die ist in `locks-routes.test.ts`
  // granular abgedeckt), daher ein einziger fester Requester.
  const requesterUserId = 'requester-id'

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('draft-lifecycle')
    await provider.writeFile(repo, pagePath, '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv1\n', {
      branch: 'main',
      message: 'seed',
    })

    space = {
      id: 'dl-space', name: 'Draft-Lifecycle Space', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    // Realistischer Bestand: main-Ref-Zeile über den echten Indexer, nicht
    // von Hand eingefügt (spaces+pages-Zeile konsistent mit dem Rest des Systems).
    await indexSpace({ db, provider }, space)

    // `locks.userId` ist seit dem P1-Fix eine NOT-NULL-FK auf `users.id` — alle
    // hier von Hand eingefügten Lock-Zeilen brauchen daher eine echte
    // `users`-Zeile.
    await db.insert(users).values([
      { id: requesterUserId, email: 'requester@test.local', displayName: 'Requester' },
      { id: 'alice-id', email: 'alice@test.local', displayName: 'Alice' },
      { id: 'bob-id', email: 'bob@test.local', displayName: 'Bob' },
      { id: 'carol-id', email: 'carol@test.local', displayName: 'Carol' },
    ])

    deps = { db }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('getDraftState/getDraft: kein Draft vor der ersten Anlage', async () => {
    expect(await getDraftState(provider, repo, pageId)).toBeNull()
    expect(await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)).toBeNull()
  })

  it('createOrGetDraft legt den Branch vom main-HEAD an und liefert baseSha/content/lock', async () => {
    const info = await createOrGetDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(info.branch).toBe(branch)
    expect(info.content).toContain('v1')
    expect(info.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(info.lock).toBeNull()

    expect(await getDraftState(provider, repo, pageId)).toBe('working')
  })

  it('createOrGetDraft ist idempotent: zweiter Aufruf liefert 200-Äquivalent mit dem Bestand, kein Fehler', async () => {
    const first = await createOrGetDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    const second = await createOrGetDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(second.branch).toBe(first.branch)
    expect(second.baseSha).toBe(first.baseSha)
    expect(second.content).toBe(first.content)
  })

  it('getDraft liefert nach der Anlage denselben Stand wie createOrGetDraft', async () => {
    const info = await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(info).not.toBeNull()
    expect(info!.branch).toBe(branch)
    expect(info!.content).toContain('v1')
  })

  it('Änderungen auf dem Draft-Branch spiegeln sich in getDraft (baseSha = aktueller Blob-SHA)', async () => {
    const before = await provider.readFile(repo, pagePath, branch)
    await provider.writeFile(repo, pagePath, '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv2 (Entwurf)\n', {
      branch,
      message: 'draft: v2',
      sha: before.sha,
    })
    const info = await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(info!.content).toContain('v2 (Entwurf)')
  })

  it('lock: null ohne Lock-Zeile, gemeldet wenn frisch (inkl. mine aus beiden Perspektiven), null wenn abgelaufen (TTL 2 min)', async () => {
    const noLock = await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(noLock!.lock).toBeNull()

    await db.insert(locks).values({ pageId, userId: 'alice-id', userName: 'Alice', heartbeatAt: new Date() })
    // Fremde Perspektive (requesterUserId !== 'alice-id'): mine=false.
    const withLock = await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(withLock!.lock).toEqual({ user: 'Alice', heartbeatAt: expect.any(String), mine: false })
    // Alices eigene Perspektive: mine=true.
    const fromOwner = await getDraft(deps, provider, repo, pageId, pagePath, 'alice-id')
    expect(fromOwner!.lock).toMatchObject({ mine: true })

    // Abgelaufener Lock (>2 min) gilt als kein Lock (Plan Global Constraints).
    const staleHeartbeat = new Date(Date.now() - 3 * 60 * 1000)
    await db.update(locks).set({ heartbeatAt: staleHeartbeat }).where(eq(locks.pageId, pageId))
    const staleInfo = await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(staleInfo!.lock).toBeNull()

    await db.delete(locks).where(eq(locks.pageId, pageId))
  })

  it('discardDraft löscht den Branch, den Lock und ruft clearDraftIndex auf; danach kein Draft mehr', async () => {
    await db.insert(locks).values({ pageId, userId: 'bob-id', userName: 'Bob', heartbeatAt: new Date() })

    await discardDraft(deps, provider, repo, pageId)

    expect(await getDraftState(provider, repo, pageId)).toBeNull()
    expect(await getDraft(deps, provider, repo, pageId, pagePath, requesterUserId)).toBeNull()
    const lockRows = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(lockRows).toHaveLength(0)
  })

  it('discardDraft wirft NotFoundError, wenn kein Draft-Branch existiert (Route mappt das auf 404)', async () => {
    await expect(discardDraft(deps, provider, repo, pageId)).rejects.toBeInstanceOf(NotFoundError)
  })

  it(
    'clearDraftIndex entfernt genau die ref=draft-Zeile der angegebenen Seite (Query-Vertrag isoliert getestet — ' +
      'aktuell erzeugt keine Task-2-Operation selbst ref=draft-Zeilen, das kommt erst mit der Draft-Indexierung ' +
      'in Task 3; die Query wird hier direkt gegen eine von Hand eingefügte Zeile geprüft)',
    async () => {
      await db.insert(pages).values({
        id: 'temp-draft-only',
        spaceId: space.id,
        path: 'temp-draft-only.md',
        ref: 'draft',
        title: 'Temp Draft',
        lang: 'de',
      })

      await clearDraftIndex(db, 'temp-draft-only')

      const rows = await db.select().from(pages).where(eq(pages.id, 'temp-draft-only'))
      expect(rows).toHaveLength(0)
    },
  )

  it('createOrGetDraft nach externem Löschen des Branches legt ihn erneut an (kein 500)', async () => {
    const info = await createOrGetDraft(deps, provider, repo, pageId, pagePath, requesterUserId)
    expect(info.branch).toBe(branch)
    expect(await getDraftState(provider, repo, pageId)).toBe('working')
  })

  it(
    'discardDraft: abbruchsichere Reihenfolge (Final-Review-Befund 2) — schlägt deleteBranch fehl, sind Index/Lock ' +
      'trotzdem bereits geräumt UND der Fehler propagiert an den Aufrufer (kein stiller Verlust: ein Retry findet ' +
      'den Branch noch vor und löscht dann nur noch ihn, statt verwaiste DB-Zeilen zu hinterlassen)',
    async () => {
      // Vorbedingung: Draft-Branch existiert bereits aus dem vorherigen Test.
      expect(await getDraftState(provider, repo, pageId)).toBe('working')

      await db.insert(locks).values({ pageId, userId: 'carol-id', userName: 'Carol', heartbeatAt: new Date() })
      await db.insert(pages).values({
        id: pageId, spaceId: space.id, path: pagePath, ref: 'draft', title: 'Home', lang: 'de',
      })

      // Wrapper um den echten Provider: alles wie gehabt, nur `deleteBranch`
      // schlägt fehl (simuliert einen abgebrochenen Prozess/Netzwerkfehler
      // NACH der Existenzprüfung, aber während des eigentlichen Löschens).
      const failingProvider: GitProvider = {
        readFile: provider.readFile.bind(provider),
        readFileBinary: provider.readFileBinary.bind(provider),
        writeFile: provider.writeFile.bind(provider),
        writeFileBinary: provider.writeFileBinary.bind(provider),
        listTree: provider.listTree.bind(provider),
        getHeadSha: provider.getHeadSha.bind(provider),
        createBranch: provider.createBranch.bind(provider),
        async deleteBranch(): Promise<never> {
          throw new Error('Netzwerkfehler beim Branch-Löschen (simuliert)')
        },
        listCommits: provider.listCommits.bind(provider),
        createPullRequest: provider.createPullRequest.bind(provider),
        getPullRequest: provider.getPullRequest.bind(provider),
        mergePullRequest: provider.mergePullRequest.bind(provider),
      }

      await expect(discardDraft(deps, failingProvider, repo, pageId)).rejects.toThrow(
        'Netzwerkfehler beim Branch-Löschen',
      )

      // DB bereits geräumt, OBWOHL der Branch noch existiert (deleteBranch schlug fehl) —
      // keine verwaisten Index-/Lock-Zeilen.
      const lockRows = await db.select().from(locks).where(eq(locks.pageId, pageId))
      expect(lockRows).toHaveLength(0)
      const draftIndexRows = await db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.ref, 'draft')))
      expect(draftIndexRows).toHaveLength(0)

      // Branch existiert noch — ein erneuter DELETE (Retry) würde ihn jetzt
      // wirklich löschen, statt (bei vertauschter Reihenfolge) mit 404 ins
      // Leere zu laufen.
      expect(await getDraftState(provider, repo, pageId)).toBe('working')

      // Aufräumen für Testisolation (dieser describe-Block läuft `.sequential`).
      await provider.deleteBranch(repo, branch)
    },
  )

  describe('getWorkflowState (Phase 2d Task 2): working / review / kein Draft nach nativem Merge', () => {
    const workflowPageId = 'workflow-page'
    const workflowPagePath = 'workflow-page.md'
    const workflowBranch = draftBranchName(workflowPageId)
    let prNumber: number

    it('kein Draft-Branch → null', async () => {
      expect(await getWorkflowState(provider, repo, workflowPageId)).toBeNull()
    })

    it('Draft-Branch ohne offenen PR → working, pr:null', async () => {
      await provider.createBranch(repo, workflowBranch, 'main')
      await provider.writeFile(
        repo,
        workflowPagePath,
        '---\nid: workflow-page\ntitle: Workflow\nlang: de\n---\n# Workflow\n\nEntwurf\n',
        { branch: workflowBranch, message: 'docs: Workflow-Entwurf' },
      )
      expect(await getWorkflowState(provider, repo, workflowPageId)).toEqual({ state: 'working', pr: null })
    })

    it('offener PR (head=draft-Branch, base=main) → review mit PR-Nummer/-Link', async () => {
      const pr = await provider.createPullRequest(repo, {
        head: workflowBranch,
        base: 'main',
        title: 'Workflow',
        body: 'Review-Test',
      })
      prNumber = pr.number
      expect(await getWorkflowState(provider, repo, workflowPageId)).toEqual({
        state: 'review',
        pr: { number: pr.number, url: pr.url },
      })
    })

    it(
      'nach nativem Merge inkl. Branch-Löschung (Häkchen "Branch löschen") → wieder null, ' +
        'kein Draft mehr (kein separat gepflegter Zustand — reine Ableitung)',
      async () => {
        await provider.mergePullRequest(repo, prNumber)
        await provider.deleteBranch(repo, workflowBranch)
        expect(await getWorkflowState(provider, repo, workflowPageId)).toBeNull()
      },
      60_000,
    )
  })

  describe('cleanupMergedDraft (Phase 2d Task 2): DB vor Branch, Branch-NotFound wird toleriert', () => {
    const cleanupPageId = 'cleanup-page'
    const cleanupBranch = draftBranchName(cleanupPageId)

    it('räumt Branch, Draft-Index-Zeile und Lock auf', async () => {
      await provider.createBranch(repo, cleanupBranch, 'main')
      // `locks.(pageId, ref='main')` hat eine FK auf `pages.(id, ref)` — die
      // main-Zeile muss also existieren, bevor der Lock angelegt werden kann
      // (unabhängig von der hier zusätzlich geprüften draft-Zeile).
      await db.insert(pages).values([
        { id: cleanupPageId, spaceId: space.id, path: 'cleanup-page.md', ref: 'main', title: 'Cleanup', lang: 'de' },
        { id: cleanupPageId, spaceId: space.id, path: 'cleanup-page.md', ref: 'draft', title: 'Cleanup', lang: 'de' },
      ])
      await db.insert(locks).values({
        pageId: cleanupPageId, userId: 'alice-id', userName: 'Alice', heartbeatAt: new Date(),
      })

      await cleanupMergedDraft(deps, provider, repo, cleanupPageId)

      await expect(provider.getHeadSha(repo, cleanupBranch)).rejects.toBeInstanceOf(NotFoundError)
      const draftRows = await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, cleanupPageId), eq(pages.ref, 'draft')))
      expect(draftRows).toHaveLength(0)
      const lockRows = await db.select().from(locks).where(eq(locks.pageId, cleanupPageId))
      expect(lockRows).toHaveLength(0)
    })

    it(
      'toleriert einen bereits fehlenden Branch (Provider hat ihn beim nativen Merge selbst ' +
        'schon gelöscht) — kein Fehler, kein Sonderfall für den Aufrufer',
      async () => {
        await expect(cleanupMergedDraft(deps, provider, repo, cleanupPageId)).resolves.toBeUndefined()
      },
    )
  })
})
