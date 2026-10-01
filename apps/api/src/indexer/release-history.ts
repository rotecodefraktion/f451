import { and, eq, inArray } from 'drizzle-orm'
import type { GitProvider, RepoRef, TreeEntry } from '@f451/git-provider'
import { parsePage, parseVersion } from '@f451/markdown'
import type { Db } from '../db/client.js'
import { pageReleases } from '../db/schema.js'
import { RELEASE_FILE, RELEASES_DIR } from '../drafts/release-archive.js'
import { recordRelease } from '../drafts/release-records.js'
import type { IndexerLogger } from './index-space.js'

/**
 * Rebuilds `page_releases` from the `_releases/` folders in the tree (#40).
 * The copies are the truth; the table is a cache:
 *
 * - copy without row → row created from the copy's `release:` block
 * - row whose copy's blob changed → `tampered`
 * - row without copy (folder deleted in Git) → row removed
 *
 * No history scan: one tree listing (already done by the indexer) plus one
 * read per copy that has no row yet.
 */
export async function syncReleases(
  deps: { db: Db; provider: GitProvider; logger?: IndexerLogger },
  space: { id: string; repoRef: RepoRef },
  tree: readonly TreeEntry[],
  pagesByPath: ReadonlyMap<string, string>,
): Promise<void> {
  const found = new Map<string, { pageId: string; version: string; path: string; sha: string }>()
  for (const entry of tree) {
    if (entry.type !== 'file') continue
    const parts = entry.path.split('/')
    const n = parts.length
    if (n < 3 || parts[n - 1] !== RELEASE_FILE || parts[n - 3] !== RELEASES_DIR) continue
    const version = parts[n - 2]!
    if (!parseVersion(version)) continue
    const dir = parts.slice(0, n - 3).join('/')
    const pageId = pagesByPath.get(dir ? `${dir}/index.md` : 'index.md')
    if (!pageId) continue
    found.set(`${pageId}@${version}`, { pageId, version, path: entry.path, sha: entry.sha })
  }

  const pageIds = [...new Set(pagesByPath.values())]
  const rows = pageIds.length
    ? await deps.db.select().from(pageReleases).where(and(eq(pageReleases.spaceId, space.id), inArray(pageReleases.pageId, pageIds)))
    : []
  const known = new Map(rows.map((r) => [`${r.pageId}@${r.version}`, r]))

  for (const [key, row] of known) {
    if (!found.has(key)) {
      await deps.db.delete(pageReleases).where(and(eq(pageReleases.pageId, row.pageId), eq(pageReleases.version, row.version)))
    }
  }

  for (const [key, copy] of found) {
    const row = known.get(key)
    if (row) {
      const tampered = row.blobSha !== copy.sha
      if (tampered !== row.tampered || row.path !== copy.path) {
        await deps.db
          .update(pageReleases)
          .set({ tampered, path: copy.path })
          .where(and(eq(pageReleases.pageId, row.pageId), eq(pageReleases.version, row.version)))
      }
      continue
    }
    try {
      const file = await deps.provider.readFile(space.repoRef, copy.path, 'main')
      const fm = parsePage(file.content).frontmatter
      const stamp = (fm.metadata?.release ?? {}) as { date?: string; by?: string }
      const note = fm.changelog?.find((e) => e.version === copy.version)?.note ?? ''
      const date = stamp.date ? new Date(stamp.date) : undefined
      await recordRelease(deps.db, {
        pageId: copy.pageId,
        spaceId: space.id,
        version: copy.version,
        path: copy.path,
        author: typeof stamp.by === 'string' ? stamp.by : '',
        note,
        blobSha: file.sha,
        classification: fm.classification ?? null,
        ...(date && !Number.isNaN(date.getTime()) ? { releasedAt: date } : {}),
      })
    } catch (err) {
      deps.logger?.warn(`indexer: release copy unreadable: ${copy.path}`, {
        spaceId: space.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

