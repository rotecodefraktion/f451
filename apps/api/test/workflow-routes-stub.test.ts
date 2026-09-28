import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  ConflictError,
  NotFoundError,
  ProviderError,
  type GitProvider,
  type PullRequestInfo,
  type RepoRef,
} from '@f451/git-provider'
import {
  findOrCreateOpenPr,
  isTolerableApproveError,
  registerWorkflowRoutes,
  waitForPrClosed,
  type WaitForPrClosedLogger,
  type WorkflowDeps,
} from '../src/routes/workflow.js'
import { ensureFrontmatterId } from '@f451/markdown'
import { registerDraftsRoutes } from '../src/routes/drafts.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, spaces as spacesTable } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Workflow-Routen: Fehlerpfade der Fix-Runde 1 (Important-Review-Befunde 1
 * und 3), isoliert von echten Provider-Netzwerkfehlern über gestubbte
 * `GitProvider`-Implementierungen — dasselbe Muster wie
 * `drafts-routes-permissions.test.ts` (kein Forgejo-Container nötig, nur
 * echtes Postgres für `resolveWriteContext`/`drafts/lifecycle.ts`).
 *
 * Finding 1: `POST /release`s Best-effort-Approve toleriert NUR `ConflictError`
 * (Self-Review/"bereits approved") still — jeder andere Fehler muss als
 * `approveWarning` in der 200-Antwort auftauchen, statt den Reviewer im
 * Glauben zu lassen, seine Freigabe sei da.
 *
 * Finding 3: schlägt nach `discardDraft` (in `drafts/update.ts#updateDraft`)
 * einer der Folgeschritte (`createOrGetDraft`) fehl, ist der alte Draft-
 * Branch bereits weg — die 502-Antwort MUSS den geretteten Inhalt
 * (`preservedContent`) tragen, sonst verliert der Nutzer seine Arbeit still.
 */
describe.sequential('Workflow-Routen: Fehlerpfade (gestubbt, Phase 2d Task 3 Fix-Runde 1)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db

  const space: SpaceConfig = {
    id: 'wf-stub-space',
    name: 'Workflow Stub Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    await db.insert(spacesTable).values({
      id: space.id, provider: space.provider, owner: space.owner, repo: space.repo,
      name: space.name, defaultLang: space.defaultLang,
    })
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
    await pg?.stop()
  })

  function shaOf(key: string, content: string): string {
    return createHash('sha1').update(`${key}:${content}`).digest('hex')
  }

  function buildTestApp(deps: WorkflowDeps, withDraftsRoutes = false): FastifyInstance {
    const app = Fastify()
    app.decorateRequest('user', null)
    // Test-Stub statt echter Session (wie `drafts-routes-permissions.test.ts`):
    // Nutzer-Id kommt aus einem Header.
    app.addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user']
      req.user = typeof userId === 'string' ? { id: userId, email: `${userId}@test.local`, displayName: userId } : null
    })
    if (withDraftsRoutes) registerDraftsRoutes(app, deps)
    registerWorkflowRoutes(app, deps)
    return app
  }

  describe('isTolerableApproveError (Finding 1, gezielter Unit-Test)', () => {
    it('ConflictError (Self-Review/"bereits approved") gilt als toleriert', () => {
      expect(isTolerableApproveError(new ConflictError('Konflikt (422)'))).toBe(true)
    })

    it('generischer ProviderError (z. B. Netzwerk-/Rate-Limit-Fehler) gilt NICHT als toleriert', () => {
      expect(isTolerableApproveError(new ProviderError('Netzwerkfehler', 503, ''))).toBe(false)
      expect(isTolerableApproveError(new ProviderError('Zeitüberschreitung', 0, ''))).toBe(false)
    })

    it('NotFoundError (kein Konflikt) gilt NICHT als toleriert', () => {
      expect(isTolerableApproveError(new NotFoundError('nicht gefunden'))).toBe(false)
    })

    it('Nicht-Provider-Fehler (z. B. Programmfehler) gilt NICHT als toleriert', () => {
      expect(isTolerableApproveError(new Error('irgendein Fehler'))).toBe(false)
      expect(isTolerableApproveError('kein Error-Objekt')).toBe(false)
    })
  })

  describe('waitForPrClosed / findOrCreateOpenPr (Task 7 Fix-Runde 1, Findings 1+2): deterministische Poll-/Timeout-Tests', () => {
    const repo: RepoRef = space.repoRef
    const branch = draftBranchName('wf-wait-page')
    const oldPr: PullRequestInfo = {
      number: 501,
      state: 'open',
      title: 'Alter Review-PR',
      headBranch: branch,
      baseBranch: 'main',
      url: 'https://forgejo.example.org/stub-owner/stub-repo/pulls/501',
      mergeable: null,
    }

    /** Minimaler `GitProvider`-Stub: jede nicht per `overrides` belegte Methode
     *  wirft bei Aufruf (dasselbe Muster wie `fakeReleaseProvider`/
     *  `fakeContentLossProvider` oben — ein unerwarteter Aufruf soll den Test
     *  hart scheitern lassen, nicht still `undefined` liefern). */
    function unexpectedProvider(overrides: Partial<GitProvider>): GitProvider {
      const unexpected = (name: string) => (): never => {
        throw new Error(`unexpectedProvider.${name}: im Test nicht erwartet`)
      }
      return {
        readFile: unexpected('readFile'),
        readFileBinary: unexpected('readFileBinary'),
        writeFile: unexpected('writeFile'),
        writeFileBinary: unexpected('writeFileBinary'),
        listTree: unexpected('listTree'),
        getHeadSha: unexpected('getHeadSha'),
        createBranch: unexpected('createBranch'),
        deleteBranch: unexpected('deleteBranch'),
        listCommits: unexpected('listCommits'),
        createPullRequest: unexpected('createPullRequest'),
        getPullRequest: unexpected('getPullRequest'),
        listPullRequests: unexpected('listPullRequests'),
        requestReviewers: unexpected('requestReviewers'),
        submitPullRequestReview: unexpected('submitPullRequestReview'),
        mergePullRequest: unexpected('mergePullRequest'),
        ...overrides,
      }
    }

    /** Deterministische Fake-Uhr: `now()` liefert den aktuellen `t`-Wert, der
     *  gestubbte `sleep` rückt `t` um die angeforderte Dauer vor UND läuft
     *  synchron durch (kein echtes Warten) — macht die 10-s-Backoff-Sequenz in
     *  Millisekunden statt Sekunden testbar (kein `vi.useFakeTimers()` nötig,
     *  da `waitForPrClosed` `now`/`sleep` bereits injectbar entgegennimmt). */
    function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
      let t = 0
      const sleeps: number[] = []
      return {
        now: () => t,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          t += ms
        },
        sleeps,
      }
    }

    it(
      'Alt-PR verschwindet nach N Aufrufen aus der open-Liste → waitForPrClosed kehrt zurück, ' +
        'findOrCreateOpenPr legt DANACH einen NEUEN PR an (nicht den alten zurückgeben)',
      async () => {
        let listCalls = 0
        let createCalls = 0
        const newPr: PullRequestInfo = {
          ...oldPr,
          number: 999,
          url: 'https://forgejo.example.org/stub-owner/stub-repo/pulls/999',
        }
        const provider = unexpectedProvider({
          async listPullRequests() {
            listCalls += 1
            // Dritter Aufruf (im Loop) ist der erste, bei dem der Alt-PR
            // tatsächlich aus der Liste verschwunden ist.
            return listCalls < 3 ? [oldPr] : []
          },
          async createPullRequest() {
            createCalls += 1
            return newPr
          },
        })
        const clock = fakeClock()

        await waitForPrClosed(provider, repo, branch, oldPr.number, { now: clock.now, sleep: clock.sleep })

        expect(listCalls).toBe(3)
        expect(clock.sleeps.length).toBe(2) // zwei Polls mit Backoff, bevor der PR verschwunden war
        expect(clock.sleeps).toEqual([250, 500])

        // Direkt danach ruft die Route dieselbe idempotente Anlage-Logik auf
        // (derselbe `provider`, genau wie in `routes/workflow.ts`) — der
        // Alt-PR ist laut Provider inzwischen weg, es MUSS ein neuer entstehen.
        const result = await findOrCreateOpenPr(provider, repo, branch, 'Titel', 'Body')
        expect(result.created).toBe(true)
        expect(result.pr.number).toBe(newPr.number)
        expect(createCalls).toBe(1)
      },
    )

    it(
      'Alt-PR bleibt offen über die Deadline → waitForPrClosed kehrt OHNE Throw zurück (dokumentiertes ' +
        'Fallback-Verhalten), loggt eine Warnung (Finding 2), und der Route-Pfad funktioniert weiter',
      async () => {
        const provider = unexpectedProvider({
          async listPullRequests() {
            // Bleibt für IMMER offen — simuliert einen Provider, der das Budget sprengt.
            return [oldPr]
          },
        })
        const clock = fakeClock()
        const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = []
        const log: WaitForPrClosedLogger = {
          warn: (obj, msg) => {
            warnings.push({ obj, msg })
          },
        }

        await expect(
          waitForPrClosed(provider, repo, branch, oldPr.number, { now: clock.now, sleep: clock.sleep, log }),
        ).resolves.toBeUndefined()

        // Timeout-Zweig geloggt (Finding 2): PR-Nummer und Budget nachvollziehbar.
        expect(warnings.length).toBe(1)
        expect(warnings[0].obj.prNumber).toBe(oldPr.number)
        expect(warnings[0].obj.budgetMs).toBe(10_000)
        expect(warnings[0].msg.toLowerCase()).toContain('budget')

        // Route-Pfad funktioniert weiter (dokumentiertes Fallback-Verhalten):
        // die nachfolgende idempotente Anlage liefert den weiterhin offenen
        // Alt-PR als "Bestand" zurück, statt zu scheitern.
        const result = await findOrCreateOpenPr(provider, repo, branch, 'Titel', 'Body')
        expect(result.created).toBe(false)
        expect(result.pr.number).toBe(oldPr.number)
      },
    )

    it('ohne log-Param bleibt der Timeout-Zweig ein stilles No-Op (Logger-Injektion ist optional)', async () => {
      const provider = unexpectedProvider({
        async listPullRequests() {
          return [oldPr]
        },
      })
      const clock = fakeClock()

      await expect(
        waitForPrClosed(provider, repo, branch, oldPr.number, { now: clock.now, sleep: clock.sleep }),
      ).resolves.toBeUndefined()
    })
  })

  describe('POST /api/pages/:id/release — approveWarning (Finding 1)', () => {
    const pageId = 'wf-release-tol'
    const pagePath = 'wf-release-tol/index.md'
    const prNumber = 42

    /** Minimaler In-Memory-GitProvider für den Release-Pfad: `listPullRequests`
     *  liefert genau einen offenen PR, `submitPullRequestReview` wirft den
     *  übergebenen Approve-Fehler (oder gar keinen), `mergePullRequest`
     *  gelingt immer. Cleanup/Reindex NACH dem Merge (`deleteBranch`/
     *  `readFile`/`listTree` etc.) dürfen scheitern — die Route toleriert das
     *  bereits (nur geloggt, Antwort bleibt 200, siehe `routes/workflow.ts`). */
    function fakeReleaseProvider(approveError: Error | undefined): GitProvider {
      const unexpected = (name: string) => (): never => {
        throw new Error(`fakeReleaseProvider.${name}: im Test nicht erwartet`)
      }
      const pr: PullRequestInfo = {
        number: prNumber,
        state: 'open',
        title: 'Release Toleranz',
        headBranch: draftBranchName(pageId),
        baseBranch: 'main',
        url: 'https://forgejo.example.org/stub-owner/stub-repo/pulls/42',
        mergeable: true,
      }
      return {
        readFile: unexpected('readFile'),
        readFileBinary: unexpected('readFileBinary'),
        writeFile: unexpected('writeFile'),
        writeFileBinary: unexpected('writeFileBinary'),
        listTree: unexpected('listTree'),
        async getHeadSha() {
          // `cleanupMergedDraft` prüft Branch-Existenz VOR dem Löschen — kein
          // Draft-Branch vorhanden ist im gestubbten Szenario der Normalfall.
          throw new NotFoundError('nicht gefunden')
        },
        createBranch: unexpected('createBranch'),
        deleteBranch: unexpected('deleteBranch'),
        listCommits: unexpected('listCommits'),
        createPullRequest: unexpected('createPullRequest'),
        getPullRequest: unexpected('getPullRequest'),
        async listPullRequests() {
          return [pr]
        },
        requestReviewers: unexpected('requestReviewers'),
        async submitPullRequestReview() {
          if (approveError) throw approveError
        },
        async mergePullRequest() {
          return { mergeSha: 'a'.repeat(40) }
        },
      }
    }

    beforeAll(async () => {
      await db.insert(pages).values({
        id: pageId, spaceId: space.id, path: pagePath, ref: 'main', title: 'Release Toleranz', lang: 'de',
      })
    })

    it('Best-effort-Approve wirft ConflictError (Self-Approve/"bereits approved") → 200 OHNE approveWarning', async () => {
      const app = buildTestApp({
        db,
        spaces: [space],
        access: { canRead: async () => true },
        canWrite: async () => true,
        getUserProvider: async () => fakeReleaseProvider(new ConflictError('Konflikt (422)')),
      })
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/release`,
        headers: { 'x-test-user': 'releaser' },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.mergeSha).toBe('a'.repeat(40))
      expect(body.approveWarning).toBeUndefined()

      await app.close()
    })

    it('Best-effort-Approve wirft einen NICHT tolerierten Fehler (z. B. Netzwerk/503) → 200 MIT approveWarning', async () => {
      const app = buildTestApp({
        db,
        spaces: [space],
        access: { canRead: async () => true },
        canWrite: async () => true,
        getUserProvider: async () => fakeReleaseProvider(new ProviderError('Netzwerkfehler', 503, '')),
      })
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/release`,
        headers: { 'x-test-user': 'releaser' },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.mergeSha).toBe('a'.repeat(40))
      expect(typeof body.approveWarning).toBe('string')
      expect(body.approveWarning).toContain('Netzwerkfehler')

      await app.close()
    })

    it('Best-effort-Approve gelingt → 200 OHNE approveWarning (Regression, Bestandsverhalten)', async () => {
      const app = buildTestApp({
        db,
        spaces: [space],
        access: { canRead: async () => true },
        canWrite: async () => true,
        getUserProvider: async () => fakeReleaseProvider(undefined),
      })
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/release`,
        headers: { 'x-test-user': 'releaser' },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().approveWarning).toBeUndefined()

      await app.close()
    })
  })

  describe('POST /api/pages/:id/draft/update — Content-Verlust-Fenster (Finding 3)', () => {
    const pageId = 'wf-update-loss'
    const pagePath = 'wf-update-loss/index.md'
    const distinctiveContent = '# Verlustfenster\n\neigene, noch ungesicherte Änderung\n'

    /** In-Memory-GitProvider mit einem scharfstellbaren Fehler: der ERSTE
     *  `createBranch`-Aufruf (Draft-Anlage im Testaufbau) gelingt, danach kann
     *  `failNextCreateBranch()` scharfgestellt werden — der NÄCHSTE
     *  `createBranch`-Aufruf (die Neuanlage in `updateDraft`, NACH dem bereits
     *  erfolgten `discardDraft`) wirft einen generischen Fehler (simuliert
     *  Netzwerk-/Provider-Ausfall GENAU in diesem Fenster). */
    function fakeContentLossProvider(): { provider: GitProvider; failNextCreateBranch: () => void } {
      const branches = new Map<string, string>([['main', '# Verlustfenster\n\nv1\n']])
      let armed = false
      const unexpected = (name: string) => (): never => {
        throw new Error(`fakeContentLossProvider.${name}: im Test nicht erwartet`)
      }
      const provider: GitProvider = {
        async readFile(_repo, path, ref) {
          const content = branches.get(ref)
          if (content === undefined) throw new NotFoundError('nicht gefunden')
          return { path, content, sha: shaOf(ref, content) }
        },
        readFileBinary: unexpected('readFileBinary'),
        writeFileBinary: unexpected('writeFileBinary'),
        async listTree() {
          return []
        },
        async getHeadSha(_repo, branch) {
          const content = branches.get(branch)
          if (content === undefined) throw new NotFoundError('nicht gefunden')
          return shaOf(branch, content)
        },
        async writeFile(_repo, _path, content, opts) {
          branches.set(opts.branch, content)
          return { commitSha: shaOf(opts.branch, content) }
        },
        async createBranch(_repo, name, fromBranch) {
          if (armed) {
            throw new Error('Netzwerkfehler: Branch-Anlage fehlgeschlagen (simuliert)')
          }
          if (branches.has(name)) throw new ConflictError('existiert bereits')
          const src = branches.get(fromBranch)
          if (src === undefined) throw new NotFoundError('Quellbranch fehlt')
          branches.set(name, src)
        },
        async deleteBranch(_repo, name) {
          if (!branches.has(name)) throw new NotFoundError('nicht gefunden')
          branches.delete(name)
        },
        listCommits: unexpected('listCommits'),
        createPullRequest: unexpected('createPullRequest'),
        getPullRequest: unexpected('getPullRequest'),
        async listPullRequests() {
          return []
        },
        requestReviewers: unexpected('requestReviewers'),
        submitPullRequestReview: unexpected('submitPullRequestReview'),
        mergePullRequest: unexpected('mergePullRequest'),
      }
      return { provider, failNextCreateBranch: () => { armed = true } }
    }

    beforeAll(async () => {
      await db.insert(pages).values({
        id: pageId, spaceId: space.id, path: pagePath, ref: 'main', title: 'Verlustfenster', lang: 'de',
      })
    })

    it(
      'createBranch schlägt NACH discardDraft fehl → 502 mit preservedContent gleich dem ' +
        'gespeicherten Draft-Inhalt (kein stiller Verlust)',
      async () => {
        const { provider, failNextCreateBranch } = fakeContentLossProvider()
        const app = buildTestApp(
          {
            db,
            spaces: [space],
            access: { canRead: async () => true },
            canWrite: async () => true,
            getUserProvider: async () => provider,
          },
          true,
        )
        await app.ready()

        // Draft anlegen (erster createBranch-Aufruf, noch nicht scharfgestellt).
        const draftRes = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/draft`,
          headers: { 'x-test-user': 'u1' },
        })
        expect(draftRes.statusCode).toBe(200)
        const { baseSha } = draftRes.json() as { baseSha: string }

        // Ungesicherte, vom main-Stand abweichende Änderung speichern —
        // GENAU dieser Inhalt muss bei einem Fehler NACH dem Verwerfen
        // erhalten bleiben.
        const saveRes = await app.inject({
          method: 'PUT',
          url: `/api/pages/${pageId}/draft`,
          headers: { 'x-test-user': 'u1' },
          payload: { content: distinctiveContent, baseSha },
        })
        expect(saveRes.statusCode).toBe(200)

        // JETZT scharfstellen: `discardDraft` (im nächsten Aufruf) gelingt,
        // aber der anschließende `createOrGetDraft`-Aufruf (Neuanlage) schlägt fehl.
        failNextCreateBranch()

        const updateRes = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/draft/update`,
          headers: { 'x-test-user': 'u1' },
          payload: { strategy: 'take-main' },
        })
        expect(updateRes.statusCode).toBe(502)
        const body = updateRes.json()
        expect(body.status).toBe('error')
        expect(typeof body.reason).toBe('string')
        // NICHT byte-identisch zum Client-Payload, sondern identisch zum
        // GESPEICHERTEN Stand: `saveDraft` ergänzt beim Schreiben die
        // Frontmatter-`id` (s. `drafts/save.ts#ensureFrontmatterId`, Fix gegen
        // den Reindex-Duplicate-Key). `preservedContent` ist der vor dem
        // Verwerfen gelesene Draft-Inhalt — genau der Stand also, auf dem der
        // Client weiterarbeiten muss. Die Prüfung bleibt exakt (kein `toContain`),
        // damit ein echter Inhaltsverlust weiterhin auffliegt.
        expect(body.preservedContent).toBe(ensureFrontmatterId(distinctiveContent, pageId))
        expect(body.preservedContent).toContain('eigene, noch ungesicherte Änderung')

        await app.close()
      },
    )
  })
})
