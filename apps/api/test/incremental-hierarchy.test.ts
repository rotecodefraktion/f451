import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { createDb, type Db } from '../src/db/client.js'
import { edges } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import { indexChangedFiles } from '../src/indexer/incremental.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * f451#133: a page indexed before its parent folder page exists gets the
 * nearest existing ancestor (here the space root) as parent. When the parent
 * arrives later — or goes away again — the child's hierarchy edge must follow.
 */
describe.sequential('indexChangedFiles: hierarchy of pages that were not changed (#133)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig

  const page = (id: string, title: string) => `---\nid: ${id}\ntitle: ${title}\nlang: en\n---\n# ${title}\n`

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()
    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('incremental-hierarchy')
    space = {
      id: 'ih-space', name: 'Incremental Hierarchy', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'en', repoRef: repo,
    }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  async function parentOf(pageId: string): Promise<string | null | undefined> {
    const rows = await db
      .select({ to: edges.toPageId })
      .from(edges)
      .where(and(eq(edges.fromPageId, pageId), eq(edges.type, 'hierarchy')))
    return rows.length === 0 ? undefined : rows[0]!.to
  }

  it('a child indexed before its parent hangs below the root', async () => {
    await provider.writeFile(repo, 'index.md', page('root', 'Root'), { branch: 'main', message: 'root' })
    await provider.writeFile(repo, 'ops/intro/index.md', page('intro', 'Intro'), { branch: 'main', message: 'intro' })
    await indexSpace({ db, provider }, space)
    expect(await parentOf('intro')).toBe('root')
  })

  it('moves the child below the parent once the parent is indexed', async () => {
    await provider.writeFile(repo, 'ops/index.md', page('ops', 'Ops'), { branch: 'main', message: 'ops' })
    await indexChangedFiles({ db, provider }, space, ['ops/index.md'], [])
    expect(await parentOf('ops')).toBe('root')
    expect(await parentOf('intro')).toBe('ops')
  })

  it('moves the child back to the root when the parent goes away', async () => {
    const current = await provider.readFile(repo, 'ops/index.md', 'main')
    await provider.deleteFile(repo, 'ops/index.md', { branch: 'main', message: 'drop ops', sha: current.sha })
    await indexChangedFiles({ db, provider }, space, [], ['ops/index.md'])
    expect(await parentOf('intro')).toBe('root')
  })
})
