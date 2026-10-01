import { parseVersion } from '@f451/markdown'
import type { Db } from '../db/client.js'
import { pageReleases } from '../db/schema.js'

/** One `page_releases` row (#38). The merge is the truth for this
 *  `(pageId, version)`, so it replaces any older row (ids can be reused). */
export async function recordRelease(
  db: Db,
  row: {
    pageId: string
    spaceId: string
    version: string
    path: string
    author: string
    note: string
    blobSha: string
    releasedAt?: Date
    tampered?: boolean
    classification?: string | null
  },
): Promise<void> {
  const parts = parseVersion(row.version)
  if (!parts) return
  const values = {
    ...row,
    ...parts,
    releasedAt: row.releasedAt ?? new Date(),
    tampered: row.tampered ?? false,
    classification: row.classification ?? null,
  }
  await db
    .insert(pageReleases)
    .values(values)
    .onConflictDoUpdate({ target: [pageReleases.pageId, pageReleases.version], set: values })
}
