import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, NotFoundError, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

const page = (id: string, title: string): string => `---\nid: ${id}\ntitle: ${title}\nlang: de\n---\n# ${title}\n`

/**
 * `DELETE /api/pages/:id` requests deletion through review (f451#155) —
 * through `buildApp`/`app.inject()` against real Forgejo and PG containers:
 * the whole page folder is deleted on the draft branch, `main` stays
 * untouched, a review is opened; refusals for the root page, a pending draft
 * and busy subpages; a draft-only page is simply discarded.
 */
describe.sequential('DELETE /api/pages/:id: request deletion through review', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: FastifyInstance

  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'dp-writer'
  const readerUserId = 'dp-reader'

  let writerSession: string
  let readerSession: string

  const seed = async (path: string, content: string): Promise<void> => {
    await provider.writeFile(repo, path, content, { branch: 'main', message: 'seed' })
  }

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('delete-page', { private: false })
    await seed('index.md', page('home', 'Home'))
    await seed('.order', 'loeschen\nmit-draft\nbusy\n')
    await seed('loeschen/index.md', page('loeschen', 'Delete candidate'))
    await seed('loeschen/_media/picture.txt', 'media')
    await seed('loeschen/.order', 'kind-b\nkind-a\n')
    await seed('loeschen/kind-a/index.md', page('kind-a', 'Child A'))
    await seed('loeschen/kind-b/index.md', page('kind-b', 'Child B'))
    await seed('loeschen/kind-b/_media/note.txt', 'media')
    await seed('mit-draft/index.md', page('mit-draft', 'With draft'))
    await seed('busy/index.md', page('busy', 'Busy parent'))
    await seed('busy/busy-kind/index.md', page('busy-kind', 'Busy child'))

    space = {
      id: 'delete-page-space', name: 'Delete Page', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    writer = await forgejo.createUser('dp-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('dp-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'dp-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'dp-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await app.ready()

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  const deleteAs = (session: string, pageId: string) =>
    app.inject({ method: 'DELETE', url: `/api/pages/${encodeURIComponent(pageId)}`, cookies: cookiesOf(session) })

  /** Opens a draft through the API and saves one change on its branch. */
  const saveDraftChange = async (pageId: string, path: string): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies: cookiesOf(writerSession),
    })
    expect(res.statusCode).toBe(200)
    const branch = draftBranchName(pageId)
    const file = await provider.readFile(repo, path, branch)
    await provider.writeFile(repo, path, `${file.content}\nChanged.\n`, {
      branch,
      message: 'draft change',
      sha: file.sha,
    })
  }

  it('without a session → 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/pages/loeschen' })
    expect(res.statusCode).toBe(401)
  })

  it('unknown page → 404', async () => {
    const res = await deleteAs(writerSession, 'gibt-es-nicht')
    expect(res.statusCode).toBe(404)
  })

  it('read-only collaborator → 403 without connect hint', async () => {
    const res = await deleteAs(readerSession, 'loeschen')
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it('root page → 409 root_page', async () => {
    const res = await deleteAs(writerSession, 'home')
    expect(res.statusCode).toBe(409)
    expect(res.json().status).toBe('root_page')
  })

  it('page with a saved draft → 409 draft_pending', async () => {
    await saveDraftChange('mit-draft', 'mit-draft/index.md')

    const res = await deleteAs(writerSession, 'mit-draft')
    expect(res.statusCode).toBe(409)
    expect(res.json().status).toBe('draft_pending')
    await expect(provider.readFile(repo, 'mit-draft/index.md', 'main')).resolves.toBeTruthy()
  })

  it('subpage with a saved draft → 409 subpage_busy naming it', async () => {
    await saveDraftChange('busy-kind', 'busy/busy-kind/index.md')

    const res = await deleteAs(writerSession, 'busy')
    expect(res.statusCode).toBe(409)
    const body = res.json() as { status: string; reason: string; pages: Array<{ id: string; title: string; path: string }> }
    expect(body.status).toBe('subpage_busy')
    expect(body.pages).toEqual([{ id: 'busy-kind', title: 'Busy child', path: 'busy/busy-kind/index.md' }])
    // Nothing was committed for the parent.
    await expect(provider.getHeadSha(repo, draftBranchName('busy'))).rejects.toBeInstanceOf(NotFoundError)
  })

  it('page with subpages and media → 200 with review; main unchanged, draft branch deletes the folder', async () => {
    const mainHeadBefore = await provider.getHeadSha(repo, 'main')

    const res = await deleteAs(writerSession, 'loeschen')
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; review: { number: number; url: string } }
    expect(body.ok).toBe(true)
    expect(typeof body.review.number).toBe('number')
    expect(body.review.url).toBeTruthy()

    // main untouched: files and index rows stay until the release.
    expect(await provider.getHeadSha(repo, 'main')).toBe(mainHeadBefore)
    await expect(provider.readFile(repo, 'loeschen/kind-a/index.md', 'main')).resolves.toBeTruthy()
    const mainRows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.ref, 'main'), inArray(pages.id, ['loeschen', 'kind-a', 'kind-b'])))
    expect(mainRows).toHaveLength(3)

    // Draft branch: nothing left under the folder, parent .order without the page.
    const branch = draftBranchName('loeschen')
    const draftTree = await provider.listTree(repo, branch)
    expect(draftTree.filter((e) => e.path === 'loeschen' || e.path.startsWith('loeschen/'))).toEqual([])
    const order = await provider.readFile(repo, '.order', branch)
    expect(order.content.split('\n')).not.toContain('loeschen')
    expect(order.content).toContain('mit-draft')

    // Draft index row marks the pending deletion.
    const draftRows = await db
      .select({ pendingDeletion: pages.pendingDeletion, path: pages.path })
      .from(pages)
      .where(and(eq(pages.id, 'loeschen'), eq(pages.ref, 'draft')))
    expect(draftRows).toEqual([{ pendingDeletion: true, path: 'loeschen/index.md' }])

    // The review is an open PR from the page's draft branch.
    const open = await provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
    expect(open.map((pr) => pr.number)).toEqual([body.review.number])
    expect(open[0]!.title).toBe('Delete: Delete candidate')

    // A repeated request returns the same review instead of refusing.
    const again = await deleteAs(writerSession, 'loeschen')
    expect(again.statusCode).toBe(200)
    expect(again.json().review.number).toBe(body.review.number)
  })

  it('draft-only page (never released) → 200 without review; branch and rows gone', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Never released' },
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as { id: string; branch: string }

    const draftRows = await db.select().from(pages).where(and(eq(pages.id, created.id), eq(pages.ref, 'draft')))
    expect(draftRows).toHaveLength(1)

    const res = await deleteAs(writerSession, created.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    await expect(provider.getHeadSha(repo, created.branch)).rejects.toBeInstanceOf(NotFoundError)
    const rowsAfter = await db.select().from(pages).where(eq(pages.id, created.id))
    expect(rowsAfter).toHaveLength(0)
  })
})
