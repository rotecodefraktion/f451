import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { LinkResolver } from './resolve-links.js'

/**
 * `.order`-Dateien (Phase 3.3, „Baum-Umsortierung"): git-native Ablage der
 * gewünschten Geschwister-Reihenfolge — EINE `.order`-Datei pro Verzeichnis,
 * die die STABILEN Seiten-Ids (Phase 3.1) ihrer direkten Kinder in
 * gewünschter Reihenfolge listet (eine Id pro Zeile). Liegt eine Seite unter
 * `<dir>/index.md`, ordnet `<dir>/.order` ihre eigenen Kinder; die oberste
 * Ebene (Kinder der Space-Startseite) wird über `.order` an der Space-Wurzel
 * geordnet (`orderFilePath('')` → `'.order'`, nicht `'/.order'`).
 *
 * Reine, IO-freie Bausteine — sowohl der Indexer (`index-space.ts#indexSpace`,
 * Voll-Reindex) als auch die Umsortier-Route (`routes/reorder.ts`) nutzen sie,
 * damit Parsen/Positions-Berechnung an EINER Stelle gepflegt werden.
 */

export const ORDER_FILENAME = '.order'

/** Pfad der `.order`-Datei, die die Kinder einer Seite mit eigenem Verzeichnis
 *  `parentDir` (`drafts/create-page.ts#directoryOf`) ordnet — leerer String
 *  ist die Space-Wurzel (die Startseite `index.md` liegt dort selbst, ihre
 *  Kinder werden über `.order` direkt an der Repo-Wurzel geordnet, NICHT
 *  `/.order`). */
export function orderFilePath(parentDir: string): string {
  return parentDir === '' ? ORDER_FILENAME : `${parentDir}/${ORDER_FILENAME}`
}

/**
 * Parst den Roh-Inhalt einer `.order`-Datei: eine Seiten-Id pro Zeile, führende/
 * abschließende Whitespace je Zeile getrimmt, leere Zeilen übersprungen. Wirft
 * nie — eine kaputte/leere Datei liefert einfach eine leere Liste (Aufrufer
 * behandelt das wie „keine `.order`-Datei vorhanden", Seiten sortieren dann
 * alphabetisch, s. Modul-Kommentar `routes/pages.ts`).
 */
export function parseOrderFile(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Berechnet den `orderKey` (0-basiert) je tatsächlichem Kind aus einer
 * geparsten `.order`-Liste: Ids, die NICHT zu einem tatsächlichen direkten
 * Kind gehören (`childIds`), werden ignoriert („unbekannte ids tolerant
 * ignorieren", Spec) — z. B. ein gelöschtes oder verschobenes Kind, dessen Id
 * noch in einer veralteten `.order`-Datei steht. Kommt eine Id MEHRFACH vor,
 * zählt nur das ERSTE Vorkommen (spätere Duplikate werden verworfen, nicht
 * als Positionswechsel gewertet). Kinder, die in der Liste gar nicht auftauchen,
 * fehlen im Ergebnis-Map — der Aufrufer setzt für sie `orderKey = null`
 * (sortieren nach Titel ans Ende, s. `routes/pages.ts`-Sortierung).
 */
export function computeOrderKeys(
  orderedIds: readonly string[],
  childIds: ReadonlySet<string>,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const id of orderedIds) {
    if (!childIds.has(id)) continue
    if (result.has(id)) continue
    result.set(id, result.size)
  }
  return result
}

/** Serialisiert eine Id-Liste zurück in `.order`-Dateiform (eine Id pro Zeile,
 *  abschließender Zeilenumbruch — dieselbe Konvention wie andere generierte
 *  Textdateien in diesem Projekt, z. B. `drafts/create-page.ts`s Frontmatter-
 *  Block). */
export function serializeOrderFile(orderedIds: readonly string[]): string {
  return orderedIds.length === 0 ? '' : `${orderedIds.join('\n')}\n`
}

const INDEX_MD_SUFFIX = '/index.md'

/** Verzeichnis einer Seiten-Datei aus ihrem Pfad — dieselbe Ableitung wie
 *  `drafts/create-page.ts#directoryOf`, hier bewusst DUPLIZIERT statt
 *  importiert: der Indexer wird bereits VON `drafts/*` importiert (z. B.
 *  `move-page.ts`, `save.ts`), nie umgekehrt — ein Import in die
 *  Gegenrichtung würde diese Schichtung für eine derart triviale
 *  Ein-Zeilen-Formel unnötig umkehren. */
function directoryOf(pagePath: string): string {
  return pagePath === 'index.md' ? '' : pagePath.slice(0, -INDEX_MD_SUFFIX.length)
}

/** Minimal-Logger-Vertrag, strukturell identisch zu `IndexerLogger`
 *  (`index-space.ts`) — hier eigenständig deklariert statt importiert, um
 *  keinen Zyklus einzuführen (`index-space.ts` importiert bereits aus diesem
 *  Modul). Jeder `IndexerLogger` erfüllt diese Form strukturell, ein Aufrufer
 *  muss also nichts anpassen. */
interface OrderFileLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * Liest je BETROFFENEM Verzeichnis (Gruppierung nach Hierarchie-Elternseite,
 * s. u.) dessen `.order`-Datei und berechnet daraus den `orderKey` je Seite
 * (Voll-Reindex-Baustein, `index-space.ts#indexSpace`). Gruppierung exakt wie
 * der Baum selbst: die `.order`-Datei, die eine Seite ordnet, liegt im
 * Verzeichnis ihrer HIERARCHIE-Elternseite (`resolver.parentOf` — dieselbe
 * Auflösung, mit der `replaceEdgesForPage` die Hierarchie-Kanten baut, s.
 * dort). Damit landen auch Seiten unter einem Verzeichnis OHNE eigene
 * `index.md` konsistent bei der `.order`-Datei ihres nächsten
 * `index.md`-Vorfahren — dieselbe Gruppe, die `GET /api/spaces/:space/tree`
 * (`routes/pages.ts`) als Geschwister rendert.
 *
 * Fail-soft je Datei (Spec §9, „Lesen darf nie ausfallen"): eine fehlende
 * `.order`-Datei (`NotFoundError`) ist der Normalfall (keine explizite
 * Reihenfolge, alle Kinder bleiben unsortiert = `orderKey` fehlt im
 * Ergebnis-Map, Aufrufer setzt `null`) und wird NICHT geloggt. Jeder ANDERE
 * Fehler (transientes IO/Netzwerkproblem) wird geloggt, aber ebenfalls NICHT
 * geworfen — dieses eine Verzeichnis bleibt für diesen Lauf unsortiert
 * (alphabetischer Fallback), der Rest des Reindex läuft unbeeinträchtigt
 * weiter; ein Folgelauf (Drift-Job) liest die Datei erneut.
 */
export async function loadOrderKeysForPages(
  provider: GitProvider,
  repo: RepoRef,
  ref: string,
  pages: readonly { id: string; path: string }[],
  resolver: LinkResolver,
  logger?: OrderFileLogger,
): Promise<Map<string, number>> {
  const childIdsByDir = new Map<string, Set<string>>()
  for (const p of pages) {
    const parent = resolver.parentOf(p.path)
    const dir = parent ? directoryOf(parent.path) : ''
    const set = childIdsByDir.get(dir) ?? new Set<string>()
    set.add(p.id)
    childIdsByDir.set(dir, set)
  }

  const result = new Map<string, number>()
  for (const [dir, childIds] of childIdsByDir) {
    const filePath = orderFilePath(dir)
    let raw: string
    try {
      raw = (await provider.readFile(repo, filePath, ref)).content
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        logger?.warn(`indexer: .order konnte nicht gelesen werden, Reihenfolge bleibt alphabetisch: ${filePath}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }
    const keys = computeOrderKeys(parseOrderFile(raw), childIds)
    for (const [id, key] of keys) result.set(id, key)
  }
  return result
}
