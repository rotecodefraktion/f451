import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { createDb, type Db } from '../src/db/client.js'
import { pages } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import { indexChangedFiles } from '../src/indexer/incremental.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Metadaten-Feature M3b Teil A: `indexChangedFiles` ermittelt `pages.lastAuthor`
 * über `provider.listCommits` (echter Forgejo-Container, echte Commit-Historie
 * — kein Mock nötig für die eigentliche Ableitung). `indexSpace` (Voll-Reindex)
 * ermittelt bewusst KEINEN Autor (s. `UpsertPageOptions.lastAuthor`-Kommentar,
 * `index-space.ts`) und darf einen bereits bekannten Wert beim erneuten Lauf
 * nicht mit `null` überschreiben (Coalesce-on-Conflict).
 */
describe.sequential('indexChangedFiles: pages.lastAuthor (Metadaten-Feature M3b Teil A)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('incremental-last-author')

    space = {
      id: 'ila-space', name: 'Incremental Last Author', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  async function lastAuthorOf(pageId: string): Promise<string | null> {
    const row = (
      await db.select({ lastAuthor: pages.lastAuthor }).from(pages).where(
        and(eq(pages.id, pageId), eq(pages.ref, 'main')),
      )
    )[0]
    return row?.lastAuthor ?? null
  }

  /** Analog `lastAuthorOf` oben, für `pages.lastBlobSha` (Task 5). */
  async function lastBlobShaOf(pageId: string): Promise<string | null> {
    const row = (
      await db.select({ lastBlobSha: pages.lastBlobSha }).from(pages).where(
        and(eq(pages.id, pageId), eq(pages.ref, 'main')),
      )
    )[0]
    return row?.lastBlobSha ?? null
  }

  it('Voll-Reindex ermittelt keinen Autor (lastAuthor bleibt null)', async () => {
    await provider.writeFile(
      repo, 'seite-a/index.md',
      '---\nid: seite-a\ntitle: Seite A\nlang: de\n---\n# Seite A\n\nv1\n',
      { branch: 'main', message: 'seed: seite-a' },
    )
    await indexSpace({ db, provider }, space)
    expect(await lastAuthorOf('seite-a')).toBeNull()
  })

  it('inkrementelle Indexierung einer geänderten Seite ermittelt den echten Commit-Autor', async () => {
    const current = await provider.readFile(repo, 'seite-a/index.md', 'main')
    await provider.writeFile(
      repo, 'seite-a/index.md',
      '---\nid: seite-a\ntitle: Seite A\nlang: de\n---\n# Seite A\n\nv2\n',
      { branch: 'main', message: 'edit: seite-a', sha: current.sha },
    )
    const report = await indexChangedFiles({ db, provider }, space, ['seite-a/index.md'], [])
    expect(report.pagesUpdated).toBe(1)

    const commits = await provider.listCommits(repo, { ref: 'main', path: 'seite-a/index.md', limit: 1 })
    expect(await lastAuthorOf('seite-a')).toBe(commits[0]!.authorName)
    expect(await lastAuthorOf('seite-a')).toBeTruthy()
  })

  it(
    'ein nachfolgender Voll-Reindex überschreibt den bereits bekannten Autor NICHT mit null '
      + '(Coalesce-on-Conflict)',
    async () => {
      const before = await lastAuthorOf('seite-a')
      expect(before).toBeTruthy()

      await indexSpace({ db, provider }, space)

      expect(await lastAuthorOf('seite-a')).toBe(before)
    },
  )

  it('eine NEUE, noch nie inkrementell indexierte Seite hat lastAuthor null nach Voll-Reindex', async () => {
    await provider.writeFile(
      repo, 'seite-b/index.md',
      '---\nid: seite-b\ntitle: Seite B\nlang: de\n---\n# Seite B\n',
      { branch: 'main', message: 'seed: seite-b' },
    )
    await indexSpace({ db, provider }, space)
    expect(await lastAuthorOf('seite-b')).toBeNull()
  })

  // Task 5 (Seitenversionierung Etappe 1): `pages.lastBlobSha` folgt GENAU
  // demselben Drei-Zustands-Muster wie `lastAuthor` oben — daher dieselbe
  // Testabfolge (inkrementell ermittelt/schreibt, Voll-Reindex lässt unangetastet).
  it('inkrementelle Indexierung schreibt den Blob-SHA der Datei in lastBlobSha', async () => {
    const current = await provider.readFile(repo, 'seite-a/index.md', 'main')
    await provider.writeFile(
      repo, 'seite-a/index.md',
      '---\nid: seite-a\ntitle: Seite A\nlang: de\n---\n# Seite A\n\nv3\n',
      { branch: 'main', message: 'edit: seite-a v3', sha: current.sha },
    )
    // Der Provider liefert den Blob-SHA der geschriebenen Fassung beim erneuten
    // Lesen (`file.sha` aus `/contents/{path}`, s. `readPageFileSafe`) — DAS ist
    // der Wert, den `indexChangedFiles` unten in `lastBlobSha` ablegen soll
    // (BEWUSST der Blob-SHA des Inhalts, nicht der Commit-SHA des Edit-Commits —
    // s. `UpsertPageOptions.lastBlobSha`-Kommentar für das WARUM).
    const file = await provider.readFile(repo, 'seite-a/index.md', 'main')

    const report = await indexChangedFiles({ db, provider }, space, ['seite-a/index.md'], [])
    expect(report.pagesUpdated).toBe(1)

    expect(await lastBlobShaOf('seite-a')).toBe(file.sha)
  })

  it(
    'ein nachfolgender Voll-Reindex schreibt den AKTUELLEN Blob-SHA in lastBlobSha, statt einen '
      + 'veralteten Wert stehen zu lassen (Befund 1, Final-Review)',
    async () => {
      const staleSha = await lastBlobShaOf('seite-a')
      expect(staleSha).toBeTruthy()

      // Fehlerszenario aus dem Review: Direkt-Commit auf main OHNE dass die
      // inkrementelle Indexierung (Webhook/`POST /release`) je läuft — genau der
      // Fall, in dem stattdessen `POST /admin/reindex` (Voll-Reindex) greift.
      const current = await provider.readFile(repo, 'seite-a/index.md', 'main')
      await provider.writeFile(
        repo, 'seite-a/index.md',
        '---\nid: seite-a\ntitle: Seite A\nlang: de\n---\n# Seite A\n\nv4 (Direkt-Commit ohne Webhook)\n',
        { branch: 'main', message: 'edit: seite-a v4 (direct commit, no webhook)', sha: current.sha },
      )
      const freshFile = await provider.readFile(repo, 'seite-a/index.md', 'main')
      // Voraussetzung des Tests: der neue Inhalt hat tatsächlich einen ANDEREN
      // SHA als der veraltete DB-Stand — sonst würde der Test auch mit dem alten,
      // fehlerhaften Verhalten (Spalte unangetastet lassen) fälschlich grün sein.
      expect(freshFile.sha).not.toBe(staleSha)

      await indexSpace({ db, provider }, space)

      // DAS ist die eigentliche Aussage von Befund 1: der Voll-Reindex ist die
      // BESSERE Quelle (er hat den SHA beim Lesen ohnehin in der Hand) und
      // schreibt ihn — nicht mehr die schlechtere, die ihn stillschweigend
      // veraltet lässt und dadurch eine falsche Versionsnummer als "unverändert"
      // ausweisen würde.
      expect(await lastBlobShaOf('seite-a')).toBe(freshFile.sha)
    },
  )

  it(
    'eine NEUE, ausschließlich per Voll-Reindex indexierte Seite bekommt trotzdem den ECHTEN Blob-SHA '
      + '(Befund 1, Final-Review — anders als bei lastAuthor, der für den Voll-Reindex weiterhin '
      + 'unermittelbar bleibt)',
    async () => {
      // `seite-b` wurde weiter oben angelegt und seither ausschließlich per
      // Voll-Reindex indexiert (nie über `indexChangedFiles`) — genau der Fall,
      // der vor dem Fix `lastBlobSha === null` ergab.
      const file = await provider.readFile(repo, 'seite-b/index.md', 'main')
      expect(await lastBlobShaOf('seite-b')).toBe(file.sha)
    },
  )

  it('bewahrt die stabile id, wenn ein Direkt-Commit das id-Frontmatter entfernt (Reindex-Duplicate-Key)', async () => {
    const path = 'seite-stabil/index.md'
    // 1. Erste Fassung MIT stabiler id → indexiert unter 'p-stabil-id'.
    await provider.writeFile(
      repo,
      path,
      '---\nid: p-stabil-id\ntitle: Stabil\nlang: de\n---\n# Stabil\n\nv1\n',
      { branch: 'main', message: 'anlegen mit id' },
    )
    await indexChangedFiles({ db, provider }, space, [path], [])
    const before = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.path, path), eq(pages.ref, 'main')))
    expect(before.map((r) => r.id)).toEqual(['p-stabil-id'])

    // 2. Direkt-Commit (am App-Save-Pfad vorbei) ENTFERNT die id.
    const cur = await provider.readFile(repo, path, 'main')
    await provider.writeFile(
      repo,
      path,
      '---\ntitle: Stabil\nlang: de\n---\n# Stabil\n\nv2 ohne id\n',
      { branch: 'main', message: 'id entfernt', sha: cur.sha },
    )

    // 3. Der Reindex darf NICHT werfen (vor dem Fix: Duplicate-Key auf
    //    pages_space_path_ref_unique, weil die Fallback-Id `path:...` unter
    //    demselben Pfad neu angelegt würde).
    await expect(indexChangedFiles({ db, provider }, space, [path], [])).resolves.toBeDefined()

    // 4. Die Seite bleibt unter der STABILEN id (keine `path:`-Zeile), und der
    //    Index ist AKTUELL (nicht still auf v1 veraltet).
    const after = await db
      .select({ id: pages.id, plainText: pages.plainText })
      .from(pages)
      .where(and(eq(pages.path, path), eq(pages.ref, 'main')))
    expect(after.map((r) => r.id)).toEqual(['p-stabil-id'])
    expect(after[0]?.plainText).toContain('v2 ohne id')
  })
})
