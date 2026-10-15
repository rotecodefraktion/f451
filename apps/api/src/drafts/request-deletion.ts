import { and, eq, inArray } from 'drizzle-orm'
import type { FileChange, GitProvider, RepoRef, TreeEntry } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { locks, pages } from '../db/schema.js'
import { isPageFile } from '../indexer/index-space.js'
import { findOrCreateOpenPr, reviewPrBody } from '../routes/workflow.js'
import { branchExists, createOrGetDraft, discardDraft, loadFreshLock } from './lifecycle.js'
import { draftBranchName } from './branch-name.js'
import { directoryOf } from './create-page.js'
import { isUnderSourceDir, removeFromParentOrderFile } from './move-page.js'

/**
 * Request the deletion of a page through review (f451#155). Deleting a page
 * deletes its whole folder — the page, all subpages, their `_media`,
 * `_releases` and `.order` files. Nothing is written to `main`: the removal is
 * one commit on the page's draft branch, and a review is opened for it. The
 * `ref='main'` index rows stay until the review is released.
 */

type PageRow = typeof pages.$inferSelect

export interface ScopePage {
  id: string
  title: string
  path: string
}

export interface DeletionScope {
  /** Indexed pages under the folder, the page itself first. A page file with
   *  no `main` index row is not listed here; its file is still in `files`. */
  pages: ScopePage[]
  /** Every file under the page folder on `main`. */
  files: TreeEntry[]
}

export type RequestDeletionResult =
  | { kind: 'discarded' }
  | { kind: 'review'; number: number; url: string }
  | {
      kind: 'refused'
      code: 'root_page' | 'draft_pending' | 'subpage_busy'
      reason: string
      pages?: ScopePage[]
    }

export interface RequestDeletionDeps {
  db: Db
  /** Injectable clock for the lock TTL (default `Date.now`). */
  now?: () => number
}

export interface RequestDeletionOpts {
  /** The requesting user — a lock held by this user does not block. */
  userId: string
  /** Public base URL for the link in the review body (optional). */
  publicBaseUrl?: string
}

function parentDirOf(dir: string): string {
  const slash = dir.lastIndexOf('/')
  return slash === -1 ? '' : dir.slice(0, slash)
}

function depthOf(path: string): number {
  return path.split('/').length
}

/**
 * Everything a deletion of `pagePath` removes, read from `main`: every file
 * under the page folder, and the indexed pages among them (id/title from the
 * `main` index rows, matched by path). The page itself comes first, then
 * subpages by depth and path.
 */
export async function deletionScope(
  db: Db,
  provider: GitProvider,
  repo: RepoRef,
  spaceId: string,
  pagePath: string,
): Promise<DeletionScope> {
  const dir = directoryOf(pagePath)
  const tree = await provider.listTree(repo, 'main')
  const files = tree.filter((e) => e.type === 'file' && isUnderSourceDir(e.path, dir))
  const pagePaths = files.filter((e) => isPageFile(e.path, e.type)).map((e) => e.path)

  const rows =
    pagePaths.length === 0
      ? []
      : await db
          .select({ id: pages.id, title: pages.title, path: pages.path })
          .from(pages)
          .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main'), inArray(pages.path, pagePaths)))

  const scopePages = [...rows].sort((a, b) => {
    if (a.path === pagePath) return -1
    if (b.path === pagePath) return 1
    return depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path)
  })
  return { pages: scopePages, files }
}

/** A subpage blocks the deletion when it has its own draft with saved changes,
 *  or someone else holds a fresh lock on it. */
async function isSubpageBusy(
  deps: RequestDeletionDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
  userId: string,
): Promise<boolean> {
  const branch = draftBranchName(pageId)
  if ((await branchExists(provider, repo, branch)) && (await provider.countCommitsAhead(repo, 'main', branch)) > 0) {
    return true
  }
  const lock = await loadFreshLock(deps, pageId, userId)
  return lock !== null && !lock.mine
}

/** A page that was never released has nothing on `main` to review: discard its
 *  draft branch, index rows and lock (the former `deletePage` for this case). */
async function discardDraftOnlyPage(
  deps: RequestDeletionDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
): Promise<void> {
  if (await branchExists(provider, repo, draftBranchName(pageId))) {
    await discardDraft({ db: deps.db }, provider, repo, pageId)
  }
  await deps.db.delete(pages).where(eq(pages.id, pageId))
  await deps.db.delete(locks).where(eq(locks.pageId, pageId))
}

async function openDeletionReview(
  provider: GitProvider,
  repo: RepoRef,
  row: PageRow,
  opts: RequestDeletionOpts,
): Promise<RequestDeletionResult> {
  const { pr } = await findOrCreateOpenPr(
    provider,
    repo,
    draftBranchName(row.id),
    `Delete: ${row.title}`,
    reviewPrBody(row.id, row.title, row.spaceId, opts.publicBaseUrl),
  )
  return { kind: 'review', number: pr.number, url: pr.url }
}

/**
 * `row` is the row `resolveWriteContext` found: the `main` row if the page was
 * ever released, otherwise its `ref='draft'` row.
 *
 * Throws `NotFoundError` when the page file is missing on `main` although a
 * `main` row exists (stale index).
 */
export async function requestDeletion(
  deps: RequestDeletionDeps,
  provider: GitProvider,
  repo: RepoRef,
  row: PageRow,
  opts: RequestDeletionOpts,
): Promise<RequestDeletionResult> {
  // 1. Never released: nothing published, nothing to review.
  if (row.ref !== 'main') {
    await discardDraftOnlyPage(deps, provider, repo, row.id)
    return { kind: 'discarded' }
  }

  // 2. The root page is the space's entry point.
  if (row.path === 'index.md') {
    return { kind: 'refused', code: 'root_page', reason: 'The start page of a space cannot be deleted.' }
  }

  // Repeated request (double click, retry after a failed review opening): the
  // deletion commit is already on the draft branch — only (re)open the review.
  const draftRow = (
    await deps.db
      .select({ pendingDeletion: pages.pendingDeletion })
      .from(pages)
      .where(and(eq(pages.id, row.id), eq(pages.ref, 'draft')))
      .limit(1)
  )[0]
  if (draftRow?.pendingDeletion) {
    return openDeletionReview(provider, repo, row, opts)
  }

  // 3. A draft with saved changes must be discarded or released first. An
  //    empty draft branch (editor opened, nothing saved) is reused below.
  const branch = draftBranchName(row.id)
  if (await branchExists(provider, repo, branch)) {
    if ((await provider.countCommitsAhead(repo, 'main', branch)) > 0) {
      return {
        kind: 'refused',
        code: 'draft_pending',
        reason: 'This page has an open draft. Discard or release it first.',
      }
    }
    // The empty branch may have been created before `main` moved on; the
    // deletion commit below uses blob SHAs from `main`. Nothing is lost by
    // recreating it — it carries no commits of its own.
    const [branchHead, mainHead] = await Promise.all([
      provider.getHeadSha(repo, branch),
      provider.getHeadSha(repo, 'main'),
    ])
    if (branchHead !== mainHead) await provider.deleteBranch(repo, branch)
  }

  // 4. Scope and busy subpages.
  const scope = await deletionScope(deps.db, provider, repo, row.spaceId, row.path)
  if (!scope.files.some((f) => f.path === row.path)) {
    throw new NotFoundError(`Page "${row.path}" does not exist on main.`)
  }
  const busy: ScopePage[] = []
  for (const page of scope.pages) {
    if (page.id === row.id) continue
    if (await isSubpageBusy(deps, provider, repo, page.id, opts.userId)) busy.push(page)
  }
  if (busy.length > 0) {
    return {
      kind: 'refused',
      code: 'subpage_busy',
      reason: 'Subpages have an open draft or are being edited by someone else. Finish or discard those first.',
      pages: busy,
    }
  }

  // 5. One commit on the draft branch: the whole folder, plus the page's
  //    entry in the parent folder's `.order`.
  await createOrGetDraft(deps, provider, repo, row.id, row.path, opts.userId)
  const dir = directoryOf(row.path)
  const changes: FileChange[] = scope.files.map((f) => ({ op: 'delete', path: f.path, sha: f.sha }))
  const orderChange = await removeFromParentOrderFile(provider, repo, parentDirOf(dir), row.id)
  if (orderChange) changes.push(orderChange)
  await provider.commitFiles(repo, changes, { branch, message: `docs: delete "${dir}"` })

  // 6. Draft index row: a copy of the main row, marked for deletion.
  const copy = { ...row, ref: 'draft', pendingDeletion: true, searchVector: null, updatedAt: new Date() }
  await deps.db.insert(pages).values(copy).onConflictDoUpdate({ target: [pages.id, pages.ref], set: copy })

  // 7. Open the review.
  return openDeletionReview(provider, repo, row, opts)
}
