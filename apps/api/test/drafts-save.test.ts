import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ForgejoProvider, NotFoundError, type GitProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { gitBlobSha1 } from '../src/drafts/blob-sha.js'
import { createOrGetDraft } from '../src/drafts/lifecycle.js'
import { DraftConflictError, saveDraft } from '../src/drafts/save.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, tags } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Autosave (Phase 2a Task 3): `saveDraft` gegen einen echten Forgejo-Container
 * — unabhängig von der HTTP-Schicht (die PUT-Route inkl. Berechtigungs-Gates
 * ist in `drafts-routes.test.ts` abgedeckt). Prüft den SHA-409-Vertrag, echte
 * Autorschaft im Git-Log und die Draft-Indexierung (ref='draft').
 */
describe.sequential('saveDraft (Phase 2a Task 3)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let adminProvider: ForgejoProvider
  let writer: ForgejoTestUser
  let writerProvider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  const pageId = 'home'
  const pagePath = 'index.md'
  const branch = draftBranchName(pageId)

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    adminProvider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('draft-save')
    await adminProvider.writeFile(repo, pagePath, '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv1\n', {
      branch: 'main',
      message: 'seed',
    })

    space = {
      id: 'ds-space', name: 'Draft Save Space', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    await indexSpace({ db, provider: adminProvider }, space)

    // Eigener Forgejo-Nutzer mit Schreibrecht — Commits müssen SEINEM Konto
    // zugerechnet werden (echte Autorschaft), nicht dem Admin/Bot-Token.
    writer = await forgejo.createUser('draft-saver')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    writerProvider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: writer.token })

    await createOrGetDraft({ db }, writerProvider, repo, pageId, pagePath, 'irrelevant-requester')
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('speichert mit dem Nutzer-Token: Commit landet auf dem Draft-Branch, echter Autor im Git-Log', async () => {
    const before = await writerProvider.readFile(repo, pagePath, branch)

    const result = await saveDraft(
      { db },
      writerProvider,
      repo,
      space,
      pageId,
      pagePath,
      'Home',
      '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv2 (Entwurf)\n',
      before.sha,
    )

    expect(result.newSha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.newSha).not.toBe(before.sha)
    expect(result.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const after = await writerProvider.readFile(repo, pagePath, branch)
    expect(after.content).toContain('v2 (Entwurf)')
    expect(after.sha).toBe(result.newSha)

    const commits = await writerProvider.listCommits(repo, { ref: branch, path: pagePath, limit: 1 })
    expect(commits[0]?.authorEmail).toBe(`${writer.username}@test.local`)
    expect(commits[0]?.message).toContain('docs: Home (Entwurf)')
  })

  it('zweiter Save mit veraltetem baseSha → 409 mit dem AKTUELLEN Inhalt (kein stiller Überschreib)', async () => {
    const staleSha = (await writerProvider.readFile(repo, pagePath, branch)).sha

    // Zwischenzeitlich ändert sich der Draft (z. B. anderer Tab/Nutzer).
    await writerProvider.writeFile(
      repo,
      pagePath,
      '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv3 (fremd)\n',
      { branch, message: 'draft: v3', sha: staleSha },
    )

    await expect(
      saveDraft(
        { db },
        writerProvider,
        repo,
        space,
        pageId,
        pagePath,
        'Home',
        '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv4 (versucht)\n',
        staleSha,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(DraftConflictError)
      const conflict = err as DraftConflictError
      expect(conflict.currentContent).toContain('v3 (fremd)')
      expect(conflict.currentSha).toMatch(/^[0-9a-f]{40}$/)
      return true
    })

    // Draft-Branch trägt weiterhin den fremden Stand, nicht "v4".
    const stillCurrent = await writerProvider.readFile(repo, pagePath, branch)
    expect(stillCurrent.content).toContain('v3 (fremd)')
  })

  it('nach dem 409 erneuter Save mit dem NEUEN baseSha → ok', async () => {
    const current = await writerProvider.readFile(repo, pagePath, branch)

    const result = await saveDraft(
      { db },
      writerProvider,
      repo,
      space,
      pageId,
      pagePath,
      'Home',
      '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv5 (nach Konflikt)\n',
      current.sha,
    )

    expect(result.newSha).toMatch(/^[0-9a-f]{40}$/)
    const after = await writerProvider.readFile(repo, pagePath, branch)
    expect(after.content).toContain('v5 (nach Konflikt)')
  })

  it('indexiert den Draft inkrementell mit ref=draft, OHNE die main-Zeile zu berühren', async () => {
    const mainBefore = (
      await db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.ref, 'main')))
    )[0]!

    const draftRow = (
      await db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.ref, 'draft')))
    )[0]

    expect(draftRow).toBeDefined()
    expect(draftRow!.plainText).toContain('v5 (nach Konflikt)')
    expect(draftRow!.spaceId).toBe(space.id)

    const mainAfter = (
      await db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.ref, 'main')))
    )[0]!
    expect(mainAfter.plainText).toBe(mainBefore.plainText)
    expect(mainAfter.plainText).not.toContain('nach Konflikt')
  })

  it(
    'newSha ist die deterministische Git-Blob-SHA des gespeicherten Inhalts (Fix Review-Befund 3): ' +
      'stimmt mit der echten Provider-SHA überein UND es findet nach dem writeFile KEIN erneutes ' +
      'readFile mehr statt (dort läge die Race mit einem fremden Zwischen-Commit)',
    async () => {
      const racePageId = 'blob-sha-race'
      const racePath = 'blob-sha-race/index.md'
      const raceBranch = draftBranchName(racePageId)
      await adminProvider.writeFile(
        repo,
        racePath,
        '---\nid: blob-sha-race\ntitle: Race\nlang: de\n---\n# Race\n',
        { branch: 'main', message: 'seed blob-sha-race' },
      )
      await indexSpace({ db, provider: adminProvider }, space)
      await createOrGetDraft({ db }, writerProvider, repo, racePageId, racePath, 'irrelevant-requester')
      const before = await writerProvider.readFile(repo, racePath, raceBranch)

      // Zähl-Wrapper (analog `providerWithBrokenReadFile` in read-api.test.ts):
      // delegiert alles an den echten Provider, zählt aber `readFile`-Aufrufe,
      // die NACH einem erfolgreichen `writeFile` passieren. Der Vorab-Check
      // (VOR dem Schreiben) zählt bewusst nicht mit.
      let writeHappened = false
      let readFileCallsAfterWrite = 0
      const countingProvider: GitProvider = {
        readFile: (r, p, ref) => {
          if (writeHappened) readFileCallsAfterWrite += 1
          return writerProvider.readFile(r, p, ref)
        },
        readFileBinary: (r, p, ref) => writerProvider.readFileBinary(r, p, ref),
        listTree: (r, ref) => writerProvider.listTree(r, ref),
        getHeadSha: (r, branch) => writerProvider.getHeadSha(r, branch),
        writeFile: async (r, p, content, opts) => {
          const result = await writerProvider.writeFile(r, p, content, opts)
          writeHappened = true
          return result
        },
        writeFileBinary: (r, p, content, opts) => writerProvider.writeFileBinary(r, p, content, opts),
        createBranch: (r, name, fromBranch) => writerProvider.createBranch(r, name, fromBranch),
        deleteBranch: (r, name) => writerProvider.deleteBranch(r, name),
        listCommits: (r, opts) => writerProvider.listCommits(r, opts),
        createPullRequest: (r, opts) => writerProvider.createPullRequest(r, opts),
        getPullRequest: (r, number) => writerProvider.getPullRequest(r, number),
        mergePullRequest: (r, number) => writerProvider.mergePullRequest(r, number),
      }

      const content = '---\nid: blob-sha-race\ntitle: Race\nlang: de\n---\n# Race\n\nv2 (race-fix)\n'
      const result = await saveDraft(
        { db },
        countingProvider,
        repo,
        space,
        racePageId,
        racePath,
        'Race',
        content,
        before.sha,
      )

      expect(readFileCallsAfterWrite).toBe(0)

      const actual = await writerProvider.readFile(repo, racePath, raceBranch)
      expect(result.newSha).toBe(actual.sha)
      expect(result.newSha).toBe(gitBlobSha1(content))
    },
  )

  it(
    'Draft-Indexierung fasst main-Tags NICHT an (tags hat kein ref im PK — Regressionstest für einen ' +
      'beim Implementieren gefundenen Bug: ein reines "where id=" beim Suchvektor-Update UND beim ' +
      'Tags-Ersetzen hätte main-Zeilen derselben Id sonst stumm überschrieben)',
    async () => {
      const taggedId = 'tagged-page'
      const taggedPath = 'tagged-page/index.md'
      await adminProvider.writeFile(
        repo,
        taggedPath,
        '---\nid: tagged-page\ntitle: Tagged\nlang: de\ntags: [wichtig]\n---\n# Tagged\n\nmain-inhalt\n',
        { branch: 'main', message: 'seed tagged page' },
      )
      await indexSpace({ db, provider: adminProvider }, space)

      const mainTagsBefore = await db.select().from(tags).where(and(eq(tags.pageId, taggedId), eq(tags.ref, 'main')))
      expect(mainTagsBefore.map((t) => t.tag)).toEqual(['wichtig'])

      await createOrGetDraft({ db }, writerProvider, repo, taggedId, taggedPath, 'irrelevant-requester')
      const draftFile = await writerProvider.readFile(repo, taggedPath, draftBranchName(taggedId))

      await saveDraft(
        { db },
        writerProvider,
        repo,
        space,
        taggedId,
        taggedPath,
        'Tagged',
        '---\nid: tagged-page\ntitle: Tagged\nlang: de\ntags: [entwurf-tag]\n---\n# Tagged\n\nentwurf-inhalt\n',
        draftFile.sha,
      )

      const mainTagsAfter = await db.select().from(tags).where(and(eq(tags.pageId, taggedId), eq(tags.ref, 'main')))
      expect(mainTagsAfter.map((t) => t.tag)).toEqual(['wichtig'])

      const draftTags = await db.select().from(tags).where(and(eq(tags.pageId, taggedId), eq(tags.ref, 'draft')))
      expect(draftTags).toHaveLength(0)

      const mainRow = (
        await db.select().from(pages).where(and(eq(pages.id, taggedId), eq(pages.ref, 'main')))
      )[0]!
      expect(mainRow.plainText).toContain('main-inhalt')
      expect(mainRow.plainText).not.toContain('entwurf-inhalt')
    },
  )

  it('Save ohne bestehenden Draft-Branch → NotFoundError statt stillem Anlegen', async () => {
    const otherPageId = 'kein-draft'
    const otherPath = 'kein-draft/index.md'
    await adminProvider.writeFile(
      repo,
      otherPath,
      '---\nid: kein-draft\ntitle: Ohne Draft\nlang: de\n---\n# Ohne Draft\n',
      { branch: 'main', message: 'seed' },
    )
    await indexSpace({ db, provider: adminProvider }, space)

    await expect(
      saveDraft(
        { db },
        writerProvider,
        repo,
        space,
        otherPageId,
        otherPath,
        'Ohne Draft',
        'egal',
        'egal-sha',
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('bewahrt die stabile id im Git-Content, wenn der Save sie weglässt (Reindex-Bug)', async () => {
    // Regression: Speichert ein Client (Editor/Import/MCP) den Inhalt OHNE
    // `id`-Frontmatter, fiele die main-Indexierung nach dem Merge auf eine
    // pfadbasierte Fallback-Id zurück und kollidierte beim inkrementellen
    // Reindex mit dem (space,path,ref)-Unique-Constraint — der Index veraltet
    // dann still. `saveDraft` erzwingt die `id` deshalb an der Schreibquelle.
    const before = await writerProvider.readFile(repo, pagePath, branch)

    const result = await saveDraft(
      { db },
      writerProvider,
      repo,
      space,
      pageId, // 'home'
      pagePath,
      'Home',
      '---\ntitle: Home\nlang: de\n---\n# Home\n\nSave OHNE id.\n',
      before.sha,
    )

    const after = await writerProvider.readFile(repo, pagePath, branch)
    // Der in Git geschriebene Content trägt die stabile id, obwohl der Save sie wegließ.
    expect(after.content).toContain('id: home')
    expect(after.content).toContain('Save OHNE id.')
    // Der zurückgegebene newSha entspricht dem TATSÄCHLICH geschriebenen (id-haltigen) Content.
    expect(after.sha).toBe(result.newSha)
  })
})
