import { posix } from 'node:path'
import { NotFoundError, type FileChange, type GitProvider, type RepoRef } from '@f451/git-provider'
import { joinFrontmatter, setFrontmatterMetadata, splitFrontmatter } from '@f451/markdown'

/**
 * Release archive (#38, spec `2026-10-01-security-klassen-und-release-archiv-design.md`,
 * part B): a frozen copy of a released page next to it in Git.
 *
 *   <page folder>/_releases/<version>/page.md   full content + `release:` block, no `id`
 *   <page folder>/_releases/<version>/_media/…  copies of the attachments the page references
 *
 * `page.md` instead of `index.md` keeps the copy out of the page index
 * (`isPageFile`). Page folders are slugs and slugs carry no underscore, so no
 * write route can ever target `_releases/` — the folder is written only here.
 */

export const RELEASES_DIR = '_releases'
export const RELEASE_FILE = 'page.md'

export function pageDir(pagePath: string): string {
  const dir = posix.dirname(pagePath)
  return dir === '.' ? '' : dir
}

export function releaseDir(pagePath: string, version: string): string {
  const dir = pageDir(pagePath)
  return `${dir ? `${dir}/` : ''}${RELEASES_DIR}/${version}`
}

/** `true` for any path inside a `_releases/` folder. */
export function isReleasePath(path: string): boolean {
  return path.split('/').includes(RELEASES_DIR)
}

export interface ReleaseStamp {
  version: string
  date: string
  by: string
  /** id of the living page; the copy has no id of its own. */
  source: string
}

/** Content of the frozen `page.md`: the page as released, plus `release:`, minus `id`. */
export function releaseCopyContent(pageContent: string, stamp: ReleaseStamp): string {
  const { frontmatterRaw, body } = splitFrontmatter(pageContent)
  const frontmatter = setFrontmatterMetadata(frontmatterRaw, { id: undefined, release: { ...stamp } })
  return joinFrontmatter(frontmatter, body)
}

/** Names in the page's `_media/` that its markdown references (as `_media/<name>`). */
export function referencedMedia(pageContent: string, mediaNames: readonly string[]): string[] {
  return mediaNames.filter(
    (name) => pageContent.includes(`_media/${name}`) || pageContent.includes(`_media/${encodeURIComponent(name)}`),
  )
}

async function existingSha(provider: GitProvider, repo: RepoRef, path: string, branch: string): Promise<string | undefined> {
  try {
    return (await provider.readFileBinary(repo, path, branch)).sha
  } catch (err) {
    if (err instanceof NotFoundError) return undefined
    throw err
  }
}

/**
 * File changes that write the frozen copy on `branch`. Existing files at the
 * target (a retry after a failed merge) are overwritten with their SHA, so the
 * release stays repeatable. Referenced attachments missing in the repository
 * are reported, not fatal.
 */
export async function buildReleaseArchiveChanges(
  provider: GitProvider,
  repo: RepoRef,
  pagePath: string,
  branch: string,
  pageContent: string,
  stamp: ReleaseStamp,
): Promise<{ changes: FileChange[]; archivePath: string; missingAttachments: string[] }> {
  const dir = pageDir(pagePath)
  const target = releaseDir(pagePath, stamp.version)
  const mediaPrefix = `${dir ? `${dir}/` : ''}_media/`

  const tree = await provider.listTree(repo, branch)
  const mediaNames = tree
    .filter((e) => e.type === 'file' && e.path.startsWith(mediaPrefix) && !e.path.slice(mediaPrefix.length).includes('/'))
    .map((e) => e.path.slice(mediaPrefix.length))
  const wanted = referencedMedia(pageContent, mediaNames)
  const missingAttachments = [...pageContent.matchAll(/_media\/([A-Za-z0-9][A-Za-z0-9._%-]*)/g)]
    .map((m) => decodeURIComponent(m[1]!))
    .filter((name, i, all) => all.indexOf(name) === i && !mediaNames.includes(name))

  const changes: FileChange[] = []
  const pageTarget = `${target}/${RELEASE_FILE}`
  changes.push({
    op: 'write',
    path: pageTarget,
    content: Buffer.from(releaseCopyContent(pageContent, stamp), 'utf8'),
    sha: await existingSha(provider, repo, pageTarget, branch),
  })
  for (const name of wanted) {
    const file = await provider.readFileBinary(repo, `${mediaPrefix}${name}`, branch)
    const copyPath = `${target}/_media/${name}`
    changes.push({ op: 'write', path: copyPath, content: file.content, sha: await existingSha(provider, repo, copyPath, branch) })
  }
  return { changes, archivePath: pageTarget, missingAttachments }
}
