import { and, eq } from 'drizzle-orm'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { edges, pages } from '../db/schema.js'
import type { SpaceConfig } from '../spaces/config.js'
import { computeOrderKeys, orderFilePath, serializeOrderFile } from '../indexer/order-file.js'
import { directoryOf, findByRefFallback, ParentPageNotFoundError } from './create-page.js'

export { ParentPageNotFoundError } from './create-page.js'

/**
 * Baum-Umsortierung (Phase 3.3, „`.order`-Dateien"): eine `id` aus `orderedIds`
 * ist KEIN direktes Kind des per `parentId` referenzierten Elternknotens (bzw.
 * der Space-Wurzel, `parentId === null`) — die geforderte Validierung
 * „orderedIds müssen die tatsächlichen direkten Kinder sein, keine Fremd-ids".
 * Auch für Duplikate innerhalb von `orderedIds` genutzt (dieselbe Id zweimal
 * ist kein gültiger Umsortierungs-Wunsch, sondern ein Client-Fehler — anders
 * als beim TOLERANTEN Parsen einer bereits bestehenden `.order`-Datei, s.
 * `indexer/order-file.ts#computeOrderKeys`s Kommentar).
 */
export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidOrderError'
  }
}

export interface ReorderChildrenResult {
  parentId: string | null
  /** Pfad der geschriebenen (bzw. gelöschten) `.order`-Datei. */
  path: string
  /** Die tatsächlich geschriebene Reihenfolge (nach Validierung). */
  orderedIds: string[]
}

/** Liest eine Datei tolerant (Muster `drafts/move-page.ts#tryReadFile`):
 *  `null` bei `NotFoundError`, sonst Inhalt + Blob-`sha` (für ein
 *  Update-`writeFile`/`deleteFile` mit Konfliktprüfung). */
async function tryReadOrderFile(
  provider: GitProvider,
  repo: RepoRef,
  path: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    return await provider.readFile(repo, path, 'main')
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/**
 * Ermittelt Verzeichnis + tatsächliche direkte Kinder eines Elternknotens für
 * die Umsortierung — DIESELBE Gruppierung wie der Baum selbst
 * (`GET /api/spaces/:space/tree`, `routes/pages.ts`) und der Indexer
 * (`indexer/order-file.ts#loadOrderKeysForPages`): „Kind" heißt „hat eine
 * ausgehende `hierarchy`-Kante auf den Elternknoten" (`edges`-Tabelle, vom
 * Indexer aus `resolver.parentOf` aufgebaut — NICHT die literale
 * Dateisystem-Verschachtelung, die bei Verzeichnissen ohne eigene `index.md`
 * abweichen würde).
 *
 * `parentId === null` (Space-Wurzel): die `.order`-Datei liegt an der
 * Repo-Wurzel (`orderFilePath('')`), ihre Kinder sind die Kinder der
 * tatsächlichen Startseite (`index.md` direkt an der Wurzel) — GENAU die
 * Seiten, die im Baum unter der Startseite sichtbar sind. Existiert
 * ausnahmsweise keine Startseite (z. B. ein noch nie vollständig indexierter
 * Space), fallen alle Seiten OHNE eingehende Hierarchie-Kante in diese
 * Gruppe (dieselbe Fallback-Definition wie `routes/pages.ts`s `rootIds`).
 */
async function resolveChildren(
  db: Db,
  spaceId: string,
  parentId: string | null,
): Promise<{ dir: string; childIds: Set<string> }> {
  if (parentId !== null) {
    const parent = await findByRefFallback(db, spaceId, 'id', parentId)
    if (!parent) {
      throw new ParentPageNotFoundError(`Übergeordnete Seite "${parentId}" ist nicht bekannt.`)
    }
    const childRows = await db
      .select({ from: edges.fromPageId })
      .from(edges)
      .innerJoin(pages, eq(edges.fromPageId, pages.id))
      .where(
        and(
          eq(pages.spaceId, spaceId),
          eq(pages.ref, 'main'),
          eq(edges.type, 'hierarchy'),
          eq(edges.toPageId, parentId),
        ),
      )
    return { dir: directoryOf(parent.path), childIds: new Set(childRows.map((r) => r.from)) }
  }

  const rootRow = (
    await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main'), eq(pages.path, 'index.md')))
      .limit(1)
  )[0]

  if (rootRow) {
    const childRows = await db
      .select({ from: edges.fromPageId })
      .from(edges)
      .innerJoin(pages, eq(edges.fromPageId, pages.id))
      .where(
        and(
          eq(pages.spaceId, spaceId),
          eq(pages.ref, 'main'),
          eq(edges.type, 'hierarchy'),
          eq(edges.toPageId, rootRow.id),
        ),
      )
    return { dir: '', childIds: new Set(childRows.map((r) => r.from)) }
  }

  // Keine Startseite bekannt: alle Seiten OHNE eingehende Hierarchie-Kante
  // (dieselbe Definition wie `routes/pages.ts`s `rootIds`-Fallback).
  const allRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main')))
  const parentedRows = await db
    .select({ from: edges.fromPageId })
    .from(edges)
    .innerJoin(pages, eq(edges.fromPageId, pages.id))
    .where(and(eq(pages.spaceId, spaceId), eq(pages.ref, 'main'), eq(edges.type, 'hierarchy')))
  const parentedIds = new Set(parentedRows.map((r) => r.from))
  return { dir: '', childIds: new Set(allRows.map((r) => r.id).filter((id) => !parentedIds.has(id))) }
}

/**
 * Schreibt eine `.order`-Datei (EIN Commit) und aktualisiert `pages.orderKey`
 * für ALLE tatsächlichen Kinder direkt (gezieltes Update statt vollem
 * Reindex/`indexChangedFiles` — eine `.order`-Datei ist keine `index.md` und
 * löst deshalb keinen Webhook-Reindex aus, s. `pages.ts#UpsertPageOptions.
 * orderKey`-Kommentar): Kinder, deren Id in `orderedIds` steht, bekommen ihre
 * Position (0-basiert); alle ÜBRIGEN Kinder (nicht in `orderedIds` enthalten)
 * werden explizit auf `orderKey = null` zurückgesetzt (sortieren dann
 * alphabetisch ans Ende, Spec-Vorgabe) — ein Teil-Reorder „vergisst" dadurch
 * nie einen alten `orderKey`-Stand für Kinder, die der Aufruf nicht erwähnt.
 *
 * `orderedIds` mit weniger als allen Kindern ist erlaubt (Teil-Reorder); jede
 * darin enthaltene Id MUSS aber ein echtes Kind sein, sonst `InvalidOrderError`
 * (400) — ebenso bei einer doppelt vorkommenden Id.
 */
export async function reorderChildren(
  deps: { db: Db },
  provider: GitProvider,
  repo: RepoRef,
  space: SpaceConfig,
  parentId: string | null,
  orderedIds: readonly string[],
): Promise<ReorderChildrenResult> {
  const { dir, childIds } = await resolveChildren(deps.db, space.id, parentId)

  const seen = new Set<string>()
  for (const id of orderedIds) {
    if (!childIds.has(id)) {
      throw new InvalidOrderError(`"${id}" ist keine direkte Kind-Seite dieses Elternknotens.`)
    }
    if (seen.has(id)) {
      throw new InvalidOrderError(`Die Id "${id}" kommt in der Reihenfolge mehrfach vor.`)
    }
    seen.add(id)
  }

  const filePath = orderFilePath(dir)
  const existing = await tryReadOrderFile(provider, repo, filePath)
  const content = serializeOrderFile(orderedIds)

  if (content.length === 0) {
    // Leere Reihenfolge → keine explizite Ordnung mehr gewünscht: eine leere
    // `.order`-Datei hätte keinen Sinn (Aufrufer würde ohnehin dieselbe
    // "unsortiert"-Situation zurückbekommen wie ganz ohne Datei) — bestehende
    // Datei wird stattdessen gelöscht, ihr Fehlen wird toleriert (Idempotenz).
    if (existing) {
      await provider.deleteFile(repo, filePath, {
        branch: 'main',
        message: `docs: Reihenfolge in „${filePath}" zurückgesetzt`,
        sha: existing.sha,
      })
    }
  } else {
    await provider.writeFile(repo, filePath, content, {
      branch: 'main',
      message: `docs: Reihenfolge in „${filePath}" aktualisiert`,
      ...(existing ? { sha: existing.sha } : {}),
    })
  }

  const orderKeys = computeOrderKeys(orderedIds, childIds)
  for (const id of childIds) {
    await deps.db
      .update(pages)
      .set({ orderKey: orderKeys.get(id) ?? null })
      .where(and(eq(pages.id, id), eq(pages.ref, 'main')))
  }

  return { parentId, path: filePath, orderedIds: [...orderedIds] }
}
