import { and, eq } from 'drizzle-orm'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { parsePage, parseVersion, type ChangelogEntry } from '@f451/markdown'
import type { Db } from '../db/client.js'
import { pageVersions } from '../db/schema.js'
import type { IndexerLogger } from './index-space.js'

/**
 * Rekonstruktion von `page_versions` aus der Git-Historie (Spec
 * `2026-07-19-seitenversionierung-design.md`, „Rekonstruktion"). Hält die
 * Zusage, dass `pg-data` verzichtbar ist: Nach einem Datenbankverlust stehen
 * die Versionen weiter im Frontmatter, nur die Zuordnung Version → Git-Stand
 * fehlte — und damit Versionsliste und -diff.
 *
 * Teuer (ein `readFile` je Commit der Datei), deshalb nur dort, wo etwas fehlt:
 * eine Seite, deren aktuelle `version` keinen Eintrag in `page_versions` hat.
 * Im Normalbetrieb schreibt die Freigabe den Eintrag selbst, und diese Prüfung
 * ist eine einzige Abfrage je versionierter Seite.
 *
 * Grenze (Spec „Grenzfälle"): Der Scan folgt dem heutigen Pfad. Versionen aus
 * der Zeit vor einem Verschieben/Umbenennen findet er nicht.
 */

const MAX_COMMITS = 200

export interface VersionedPage {
  id: string
  path: string
  version: string | undefined
}

export async function reconstructMissingVersions(
  deps: { db: Db; provider: GitProvider; logger?: IndexerLogger },
  space: { id: string; repoRef: RepoRef },
  seiten: readonly VersionedPage[],
): Promise<number> {
  let rekonstruiert = 0
  for (const seite of seiten) {
    if (!parseVersion(seite.version)) continue
    const [vorhanden] = await deps.db
      .select({ version: pageVersions.version })
      .from(pageVersions)
      .where(and(eq(pageVersions.pageId, seite.id), eq(pageVersions.version, seite.version!)))
      .limit(1)
    if (vorhanden) continue
    try {
      rekonstruiert += await reconstructPageVersions(deps, space, seite)
    } catch (err) {
      // Best effort: ein Provider-Aussetzer darf den Reindex nicht kippen; der
      // nächste Voll-Reindex versucht es erneut.
      deps.logger?.warn('Versionshistorie nicht rekonstruierbar', {
        pageId: seite.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return rekonstruiert
}

/** Geht die Historie einer Datei vom ältesten Commit an durch; wo sich die
 *  `version` ändert, entsteht ein Eintrag. Liefert die Zahl neuer Einträge. */
export async function reconstructPageVersions(
  deps: { db: Db; provider: GitProvider },
  space: { id: string; repoRef: RepoRef },
  seite: { id: string; path: string },
): Promise<number> {
  const commits = await deps.provider.listCommits(space.repoRef, { ref: 'main', path: seite.path, limit: MAX_COMMITS })
  let vorherige: string | undefined
  let neu = 0
  let changelog: ChangelogEntry[] | undefined
  for (const commit of [...commits].reverse()) {
    const datei = await deps.provider.readFile(space.repoRef, seite.path, commit.sha)
    const { frontmatter } = parsePage(datei.content)
    changelog = frontmatter.changelog
    const teile = parseVersion(frontmatter.version)
    if (!teile || frontmatter.version === vorherige) continue
    vorherige = frontmatter.version

    // Der oberste Changelog-Eintrag gehört zu genau dieser Version — die
    // Freigabe schreibt beides im selben Commit. Fehlt er (handgeschrieben),
    // tragen die Commit-Metadaten.
    const oberster = frontmatter.changelog?.[0]
    const eintrag = oberster?.version === frontmatter.version ? oberster : undefined
    const ergebnis = await deps.db
      .insert(pageVersions)
      .values({
        pageId: seite.id,
        spaceId: space.id,
        version: frontmatter.version!,
        ...teile,
        // Commit-SHA als Git-Referenz für den Diff. Der Pfadfilter der Historie
        // blendet den Merge-Commit meist aus; der Commit, der die Version
        // schrieb, liefert beim Lesen denselben Dateistand.
        mergeSha: commit.sha,
        blobSha: datei.sha,
        releasedAt: new Date(eintrag?.date ?? commit.date),
        author: eintrag?.author ?? commit.authorName,
        note: eintrag?.note ?? '',
      })
      .onConflictDoNothing()
      .returning({ version: pageVersions.version })
    neu += ergebnis.length
  }

  // Versions no release commit wrote — the implicit 0.1.0 of an existing
  // page (f451#50) — name their commit in the changelog (`ref`).
  for (const eintrag of changelog ?? []) {
    const teile = parseVersion(eintrag.version)
    if (!eintrag.ref || !teile) continue
    const datei = await deps.provider.readFile(space.repoRef, seite.path, eintrag.ref)
    const ergebnis = await deps.db
      .insert(pageVersions)
      .values({
        pageId: seite.id,
        spaceId: space.id,
        version: eintrag.version,
        ...teile,
        mergeSha: eintrag.ref,
        blobSha: datei.sha,
        releasedAt: new Date(eintrag.date),
        author: eintrag.author,
        note: eintrag.note,
      })
      .onConflictDoNothing()
      .returning({ version: pageVersions.version })
    neu += ergebnis.length
  }
  return neu
}
