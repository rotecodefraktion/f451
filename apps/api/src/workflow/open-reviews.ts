import { and, eq } from 'drizzle-orm'
import type { GitProvider, PullRequestInfo } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { pages } from '../db/schema.js'
import { draftBranchName } from '../drafts/branch-name.js'
import type { SpaceConfig } from '../spaces/config.js'

export interface DraftRow {
  id: string
  title: string
  path: string
  lastAuthor: string | null
  updatedAt: Date
}

export interface OpenReview {
  row: DraftRow
  pr: PullRequestInfo
}

/**
 * Draft rows of the space and the open PRs (base main) that belong to them.
 * One SELECT on `ref = 'draft'` rows and ONE `listPullRequests` call per load
 * (never one provider round trip per page), matched via `draftBranchName(id)`.
 * Without drafts the provider is not asked at all.
 * Throws when the provider call fails; callers decide how to degrade.
 */
export async function openReviews(
  db: Db,
  provider: GitProvider,
  space: SpaceConfig,
): Promise<{ drafts: DraftRow[]; open: OpenReview[] }> {
  const drafts: DraftRow[] = await db
    .select({
      id: pages.id,
      title: pages.title,
      path: pages.path,
      lastAuthor: pages.lastAuthor,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), eq(pages.ref, 'draft')))
  if (drafts.length === 0) return { drafts, open: [] }

  const byBranch = new Map<string, DraftRow>()
  for (const row of drafts) byBranch.set(draftBranchName(row.id), row)

  const openPrs = await provider.listPullRequests(space.repoRef, { base: 'main', state: 'open' })
  const open: OpenReview[] = []
  for (const pr of openPrs) {
    const row = byBranch.get(pr.headBranch)
    if (row) open.push({ row, pr })
  }
  return { drafts, open }
}
