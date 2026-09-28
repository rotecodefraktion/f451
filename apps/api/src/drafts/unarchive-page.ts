import { eq } from 'drizzle-orm'
import { joinFrontmatter, setFrontmatterMetadata, splitFrontmatter } from '@f451/markdown'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { locks } from '../db/schema.js'
import type { SpaceConfig } from '../spaces/config.js'
import { indexChangedFiles } from '../indexer/incremental.js'
import { branchExists, LOCK_TTL_MS } from './lifecycle.js'
import { draftBranchName } from './branch-name.js'

/**
 * Holt eine Seite „aus dem Archiv" (Feature „Unarchive"): eine archivierte
 * Seite blendet den „Bearbeiten"-Link in der Leseansicht aus
 * (`components/page-view.tsx`) — ohne diesen Weg käme niemand mehr in den
 * Editor, um `archived` aus dem Frontmatter zu entfernen. Schreibt deshalb
 * DIREKT auf `main` (kein Draft-Umweg, Muster `drafts/create-page.ts`s
 * Metadaten-Schreibpfaden bzw. `routes/metadata-schema.ts`): entfernt via
 * `setFrontmatterMetadata(raw, { archived: undefined })` — DERSELBE Helfer
 * wie das „Archivieren"-Toggle im Editor (`editor-root.tsx#handleArchivedToggle`)
 * — das `archived`-Feld komplett aus dem Frontmatter, statt es explizit auf
 * `false` zu setzen (Konvention „nicht gesetzt = nicht archiviert", identisch
 * zum Editor-Toggle).
 *
 * Blockiert (409) wie `drafts/move-page.ts#movePage`, wenn die Seite einen
 * offenen Draft-Branch ODER einen aktiven Lock hat: ein Draft mit noch dem
 * alten (archivierten) Frontmatter-Stand würde beim nächsten Speichern diese
 * Änderung sofort wieder überschreiben — deshalb „erst Review abschließen
 * oder Entwurf verwerfen".
 */

export interface UnarchivePageDeps {
  db: Db
  /** Injectbare Uhr (Default: Date.now) — für deterministische Lock-TTL-Tests,
   *  dasselbe Muster wie `MovePageDeps.now` (`drafts/move-page.ts`). */
  now?: () => number
}

export interface UnarchivePageResult {
  id: string
  path: string
}

/** Blockiert das Unarchivieren (409), weil die Seite einen offenen
 *  Draft/Review ODER einen aktiven Lock hat (Muster
 *  `drafts/move-page.ts#MoveBlockedError`). */
export class UnarchiveBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnarchiveBlockedError'
  }
}

/** Lädt den frischesten Lock-Zeitstempel und meldet, ob er noch innerhalb der
 *  TTL frisch ist — dupliziert aus `drafts/move-page.ts#hasFreshLock` (bewusst,
 *  Muster dortiger Kommentare zu kleinen, einmalig genutzten Helfern: kein
 *  gemeinsames Modul für eine 6-Zeilen-Funktion). */
async function hasFreshLock(db: Db, pageId: string, now: () => number): Promise<boolean> {
  const rows = await db.select().from(locks).where(eq(locks.pageId, pageId)).limit(1)
  const row = rows[0]
  if (!row) return false
  return now() - row.heartbeatAt.getTime() < LOCK_TTL_MS
}

export async function unarchivePage(
  deps: UnarchivePageDeps,
  provider: GitProvider,
  repo: RepoRef,
  space: SpaceConfig,
  pageId: string,
  pagePath: string,
): Promise<UnarchivePageResult> {
  const now = deps.now ?? Date.now

  // Existenz auf main ZUERST prüfen (Muster `movePage`s Schritt 3 vor Schritt
  // 4): eine draft-only Seite (nie released) hat i. d. R. bereits ihren
  // eigenen Draft-Branch (aus der Anlage) — ohne diese Reihenfolge würde sie
  // fälschlich als 409-Blockade statt als 404 („nichts auf main zu
  // unarchivieren") gemeldet. `readFile` wirft hier selbst `NotFoundError`,
  // die Route mappt sie auf 404.
  const file = await provider.readFile(repo, pagePath, 'main')

  const [hasDraft, hasLock] = await Promise.all([
    branchExists(provider, repo, draftBranchName(pageId)),
    hasFreshLock(deps.db, pageId, now),
  ])
  if (hasDraft || hasLock) {
    throw new UnarchiveBlockedError(
      'Diese Seite hat einen offenen Entwurf oder aktiven Lock — erst Review abschließen oder Entwurf '
        + 'verwerfen, bevor sie aus dem Archiv geholt werden kann.',
    )
  }

  const { frontmatterRaw, body } = splitFrontmatter(file.content)
  const newFrontmatterRaw = setFrontmatterMetadata(frontmatterRaw, { archived: undefined })
  const newContent = joinFrontmatter(newFrontmatterRaw, body)

  await provider.writeFile(repo, pagePath, newContent, {
    branch: 'main',
    message: `docs: „${pagePath}" aus dem Archiv geholt`,
    sha: file.sha,
  })

  // Reindex (Muster `drafts/move-page.ts` Schritt 10): der geänderte
  // `archived`-Status muss in der `pages`-Zeile (`ref='main'`) ankommen,
  // sonst zeigt z. B. der Graph den Status weiter als „archiviert".
  await indexChangedFiles({ db: deps.db, provider }, space, [pagePath], [])

  return { id: pageId, path: pagePath }
}
