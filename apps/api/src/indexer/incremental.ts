import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { GitProvider } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { edges, pages } from '../db/schema.js'
import type { OpsCounters } from '../ops/counters.js'
import type { SpaceConfig } from '../spaces/config.js'
import {
  buildPageInfo,
  isPageFile,
  readPageFileSafe,
  replaceEdgesForPage,
  upsertPage,
  type IndexerLogger,
  type PageInfo,
} from './index-space.js'
import { LinkResolver, type ResolvablePage } from './resolve-links.js'

export interface IncrementalDeps {
  db: Db
  provider: GitProvider
  logger?: IndexerLogger
  /** Task 5 (Betrieb): siehe `IndexerDeps.counters` in `index-space.ts` — hier
   *  dieselbe Weitergabe an `readPageFileSafe` für den Webhook-Pfad. */
  counters?: OpsCounters
}

export interface IncrementalReport {
  pagesUpdated: number
  pagesRemoved: number
  brokenLinksHealed: number
  /** Geänderte Dateien, deren `readFile` mit einem transienten IO/Netzwerk-Fehler
   *  abgebrochen ist und die deshalb komplett übersprungen wurden (F1): die
   *  bestehende Index-Zeile bleibt unangetastet statt still mit leerem Inhalt
   *  überschrieben zu werden. Ein erneuter Webhook oder der Drift-Job holt die
   *  Datei nach (der Voll-Reindex rückt `indexedHeadSha` bei IO-Fehlern nicht vor). */
  filesSkippedIo: number
}

/**
 * Ermittelt den Autor des letzten Commits einer Datei (Metadaten-Feature M3b
 * Teil A, `pages.lastAuthor`) über `provider.listCommits(..., {limit: 1})` —
 * fail-soft wie `readPageFileSafe`: JEDER Provider-Fehler (Netzwerk, Rate-
 * Limit, Datei ohne Historie, …) liefert `null` (Autor „unbekannt") statt die
 * inkrementelle Indexierung abzubrechen; „Lesen darf nie ausfallen" (Spec §9)
 * gilt für diese Zusatz-Auskunft genauso wie für den Seiteninhalt selbst.
 * Fehler werden geloggt (WENN ein Logger übergeben wurde), aber NICHT über
 * `OpsCounters` gezählt — anders als `readPageFileSafe`s IO-Fehler ist das
 * hier kein Grund, den gesamten Lauf als unvollständig zu markieren
 * (`indexedHeadSha` wird von diesem Pfad ohnehin nicht gesetzt, s.
 * `index-space.ts#indexSpace`).
 */
async function fetchLastAuthor(
  provider: GitProvider,
  space: SpaceConfig,
  filePath: string,
  ref: string,
  logger?: IndexerLogger,
): Promise<string | null> {
  try {
    const commits = await provider.listCommits(space.repoRef, { ref, path: filePath, limit: 1 })
    return commits[0]?.authorName ?? null
  } catch (err) {
    logger?.warn(`indexer: listCommits fehlgeschlagen, last_author bleibt unbekannt: ${filePath}`, {
      spaceId: space.id,
      path: filePath,
      ref,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Inkrementelles Indexieren nach einem Push-Webhook (Plan Task 4). Liest NUR
 * die geänderten Dateien (nicht den ganzen Baum), aktualisiert Seiten/Kanten/
 * Suche, entfernt gelöschte Seiten (eingehende Kanten degradieren automatisch
 * zu Broken Links über `ON DELETE SET NULL`, siehe Schema) und versucht danach
 * alle Broken-Links des Space neu aufzulösen — eine neu gepushte Seite kann
 * damit alte kaputte Links heilen.
 *
 * Nur `index.md`-Pfade werden berücksichtigt (Task-3-Baustein `isPageFile`
 * wiederverwendet); alle anderen geänderten/entfernten Pfade werden ignoriert.
 */
export async function indexChangedFiles(
  deps: IncrementalDeps,
  space: SpaceConfig,
  changedPaths: readonly string[],
  removedPaths: readonly string[],
): Promise<IncrementalReport> {
  const { db, provider, logger, counters } = deps
  const ref = 'main'

  // Entfernte Pfade gewinnen bei Überschneidung (Endzustand des Push zählt).
  const removedSet = new Set(removedPaths.filter((p) => isPageFile(p, 'file')))
  const changedPageFiles = [...new Set(changedPaths.filter((p) => isPageFile(p, 'file') && !removedSet.has(p)))]
  const removedPageFiles = [...removedSet]

  // --- Lesen + Parsen der geänderten Seiten (nur diese, nicht der ganze Baum) ---
  const changedInfos: PageInfo[] = []
  // Autor des letzten Commits je geänderter Seite (Metadaten-Feature M3b Teil A,
  // `pages.lastAuthor`) — NUR hier (inkrementell, kleine Dateimenge pro Aufruf)
  // ermittelt, NICHT im Voll-Reindex (`index-space.ts#indexSpace`, s. dortiger
  // `UpsertPageOptions.lastAuthor`-Kommentar: dort wäre ein `listCommits`-Aufruf
  // PRO Seite ein unverhältnismäßiger O(n)-Mehraufwand bei potenziell sehr
  // vielen Dateien). `indexChangedFiles` läuft dagegen genau dann, wenn sich
  // WIRKLICH etwas geändert hat (Webhook-Push ODER `POST /release`) — die
  // Dateimenge ist inhärent klein (typischerweise 1).
  const lastAuthorByPath = new Map<string, string | null>()
  // Blob-SHA der gelesenen Fassung je geänderter Seite (Seitenversionierung
  // Etappe 1, Task 5, `pages.lastBlobSha`) — kommt beim ohnehin nötigen
  // `readPageFileSafe`-Aufruf unten OHNE zusätzlichen Provider-Aufruf mit (der
  // Provider liefert ihn als `GitFile.sha` aus `/contents/{path}`, s.
  // `readPageFileSafe`/`fillReleaseMetadataOnDraft` in `drafts/release-metadata.ts`
  // — BEWUSST der Blob-SHA des Dateiinhalts, nicht der Commit-SHA, s.
  // `UpsertPageOptions.lastBlobSha`-Kommentar in `index-space.ts` für das WARUM),
  // anders als `lastAuthor` oben, der einen eigenen `listCommits`-Aufruf braucht.
  const lastBlobShaByPath = new Map<string, string | null>()
  let filesSkippedIo = 0
  for (const filePath of changedPageFiles) {
    const file = await readPageFileSafe(provider, space, filePath, ref, logger, counters)
    if (file === null) {
      // Transienter IO/Netzwerk-Fehler beim Lesen (F1, bereits geloggt): Datei
      // komplett überspringen statt eine leere Seite zu upserten. Die bestehende
      // Index-Zeile bleibt über `existingRows`/`byPath` unten auch für die
      // Link-Auflösung erhalten.
      filesSkippedIo += 1
      continue
    }
    changedInfos.push(buildPageInfo(space.id, filePath, file.content, space.defaultLang, space.name))
    lastAuthorByPath.set(filePath, await fetchLastAuthor(provider, space, filePath, ref, logger))
    lastBlobShaByPath.set(filePath, file.sha)
  }

  const existingRows = await db
    .select({ id: pages.id, path: pages.path, title: pages.title })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), eq(pages.ref, ref)))

  const removedRows =
    removedPageFiles.length > 0
      ? existingRows.filter((r) => removedPageFiles.includes(r.path))
      : []

  // Stabile-id-Bewahrung beim inkrementellen Reindex (zweite Verteidigungslinie
  // gegen den Reindex-Duplicate-Key, s. `drafts/save.ts#ensureFrontmatterId`
  // für die primäre an der Schreibquelle): Trägt eine geänderte Datei im
  // Frontmatter keine `id`, hat `derivePageId` oben eine pfadbasierte
  // Fallback-Id (`path:...`) vergeben. Existiert für denselben Pfad aber
  // bereits eine STABILE Zeile (etwa nach einem Direkt-Commit in Forgejo, der
  // die `id` entfernt hat), muss deren id beibehalten werden — sonst legt
  // `upsertPage` die Datei unter der neuen Fallback-Id an und kollidiert mit
  // dem `(space_id, path, ref)`-Unique-Constraint der Altzeile (Duplicate-Key,
  // im Release-/Webhook-Pfad still gefangen → Index veraltet unbemerkt).
  const stableIdByPath = new Map(existingRows.map((r) => [r.path, r.id]))
  for (const info of changedInfos) {
    if (info.id.startsWith('path:')) {
      const stable = stableIdByPath.get(info.path)
      if (stable !== undefined && !stable.startsWith('path:')) info.id = stable
    }
  }

  // Gesamtsicht auf alle Seiten des Space für die Link-Auflösung: bestehende
  // Seiten (ohne entfernte) plus die neuen/aktualisierten Fassungen der
  // geänderten Seiten (überschreiben ggf. den alten Stand desselben Pfads).
  const byPath = new Map<string, ResolvablePage>()
  for (const row of existingRows) {
    if (!removedPageFiles.includes(row.path)) byPath.set(row.path, row)
  }
  for (const info of changedInfos) {
    byPath.set(info.path, { id: info.id, path: info.path, title: info.title })
  }
  const resolver = new LinkResolver([...byPath.values()])

  let brokenLinksHealed = 0

  await db.transaction(async (tx) => {
    if (removedRows.length > 0) {
      // ref-Filter (Fix Review-Befund 1, Task 2a-3): seit der Composite-PK-
      // Umstellung `(id, ref)` kann dieselbe `id` gleichzeitig als
      // `ref='main'`- UND `ref='draft'`-Zeile existieren (offener Autoren-
      // Entwurf zu genau dieser Seite). Ein ungescoptes Delete über `id`
      // allein würde BEIDE Zeilen treffen, sobald main gelöscht wird, und den
      // Draft-Index-Eintrag still mitreißen. Dieser Indexer arbeitet — wie
      // der Rest der Funktion (`const ref = 'main'` oben) — ausschließlich
      // auf main, daher hier explizit danach filtern (analog `index-space.ts`).
      await tx.delete(pages).where(and(eq(pages.ref, ref), inArray(pages.id, removedRows.map((r) => r.id))))
    }

    // Issue #7: dieselbe Id-Konflikt-Grenze wie der Voll-Reindex
    // (`index-space.ts#indexSpace`) — `upsertPage` verweigert das Schreiben,
    // wenn `(p.id, ref)` bereits einem ANDEREN Space gehört (WHERE-Klausel im
    // `onConflictDoUpdate`, s. dortiger Kommentar). Eine so übersprungene Seite
    // bekommt hier keine Kanten — sie würden sonst unter der Id der FREMDEN
    // Zeile landen, obwohl der Inhalt von DIESEM Space stammt.
    const conflictedIds = new Set<string>()
    for (const p of changedInfos) {
      const result = await upsertPage(tx, space.id, ref, p, resolver, {
        lastAuthor: lastAuthorByPath.get(p.path) ?? null,
        lastBlobSha: lastBlobShaByPath.get(p.path) ?? null,
      })
      if (!result.written) {
        conflictedIds.add(p.id)
        logger?.warn(`indexer: id-Konflikt (inkrementell), Seite gehört bereits einem anderen Space: ${p.id}`, {
          spaceId: space.id,
          path: p.path,
          ownerSpace: result.conflictingSpaceId ?? 'unknown',
        })
      }
    }
    for (const p of changedInfos) {
      if (conflictedIds.has(p.id)) continue
      await replaceEdgesForPage(tx, p, resolver)
    }

    // --- Broken-Link-Heilung: alle Kanten mit toPageId IS NULL des Space ------
    const brokenRows = await tx
      .select({
        fromPageId: edges.fromPageId,
        rawTarget: edges.rawTarget,
        type: edges.type,
        label: edges.label,
        fromPath: pages.path,
      })
      .from(edges)
      .innerJoin(pages, eq(edges.fromPageId, pages.id))
      .where(and(eq(pages.spaceId, space.id), isNull(edges.toPageId)))

    for (const row of brokenRows) {
      const healedId = resolver.healBroken(
        row.rawTarget,
        row.type as 'link' | 'relation' | 'hierarchy',
        row.fromPath,
      )
      if (healedId === null) continue
      await tx
        .update(edges)
        .set({ toPageId: healedId })
        .where(
          and(
            eq(edges.fromPageId, row.fromPageId),
            eq(edges.rawTarget, row.rawTarget),
            eq(edges.type, row.type),
            eq(edges.label, row.label),
          ),
        )
      brokenLinksHealed += 1
    }
  })

  return {
    pagesUpdated: changedInfos.length,
    pagesRemoved: removedRows.length,
    brokenLinksHealed,
    filesSkippedIo,
  }
}
