import type { GitProvider, RepoRef } from '@f451/git-provider'
import { ConflictError } from '@f451/git-provider'
import { ensureFrontmatterId } from '@f451/markdown'
import type { Db } from '../db/client.js'
import type { SpaceConfig } from '../spaces/config.js'
import { buildPageInfo, upsertPage } from '../indexer/index-space.js'
import { LinkResolver } from '../indexer/resolve-links.js'
import { draftBranchName } from './branch-name.js'
import { gitBlobSha1 } from './blob-sha.js'

/**
 * 409-Vertrag (Plan Abschnitt 9, Global Constraints, Task 3): geworfen bei
 * SHA-Abweichung — sowohl beim billigen Vorab-Check (bekannter `baseSha`
 * weicht vom aktuellen Draft-Stand ab) als auch beim `ConflictError` des
 * Providers (Race zwischen Vorab-Check und Schreiben). Trägt den AKTUELLEN
 * Stand, aus dem der Aufrufer (Route) die 409-Antwort `{ error, currentSha,
 * currentContent }` baut — der Client baut daraus die Zusammenführungsansicht.
 */
export class DraftConflictError extends Error {
  constructor(
    message: string,
    public readonly currentSha: string,
    public readonly currentContent: string,
  ) {
    super(message)
    this.name = 'DraftConflictError'
  }
}

export interface SaveDraftResult {
  newSha: string
  savedAt: string
}

export interface SaveDraftDeps {
  db: Db
}

/**
 * Autosave auf dem Draft-Branch (Plan Task 3). Committet mit dem NUTZER-Token
 * (der `provider` kommt vom Aufrufer bereits nutzergebunden, siehe
 * `drafts/user-provider.ts` — echte Autorschaft, kein Bot) und indexiert die
 * Seite anschließend inkrementell mit `ref='draft'` (siehe `indexDraftPage`
 * unten), damit sie für Autoren such- und auffindbar ist (Lese-API bleibt
 * main-only, unverändert).
 *
 * SHA-Vertrag: `baseSha` muss dem aktuellen Blob-SHA der Datei auf dem
 * Draft-Branch entsprechen. Ein billiger Vorab-`readFile` prüft das, BEVOR
 * überhaupt geschrieben wird (vermeidet unnötige Schreib-Versuche); ein
 * `ConflictError` des Providers selbst (Race: ein anderer Save zwischen
 * Vorab-Check und Schreiben) wird ebenso auf denselben `DraftConflictError`
 * gemappt — in beiden Fällen wird der Stand FRISCH nachgeladen, damit die
 * 409-Antwort garantiert den aktuell gültigen Inhalt trägt.
 *
 * `newSha` (Fix Review-Befund 3, Task 2a-3): NICHT per nachgelagertem
 * `readFile` nach dem erfolgreichen `writeFile` ermittelt — das wäre eine
 * Race (schreibt zwischen `writeFile` und `readFile` ein anderer Nutzer,
 * liefert das `readFile` dessen SHA, nicht den eigenen; der nächste
 * Vorab-Check des ursprünglichen Aufrufers "stimmt" dann fälschlich und
 * überschreibt fremden Inhalt ohne 409). Stattdessen deterministisch aus dem
 * SELBST geschriebenen `content` berechnet (`gitBlobSha1`, Git-Blob-SHA-
 * Formel) — siehe `blob-sha.ts`.
 *
 * Wirft `NotFoundError` unverändert durch, wenn der Draft-Branch/die Datei
 * (noch) nicht existiert — Autosave legt NIE selbst einen Draft an (kein
 * stilles Anlegen; der Aufrufer mappt das wie bei GET/DELETE auf 404).
 */
export async function saveDraft(
  deps: SaveDraftDeps,
  provider: GitProvider,
  repo: RepoRef,
  space: SpaceConfig,
  pageId: string,
  pagePath: string,
  title: string,
  content: string,
  baseSha: string,
  message?: string,
): Promise<SaveDraftResult> {
  const branch = draftBranchName(pageId)

  const current = await provider.readFile(repo, pagePath, branch)
  if (current.sha !== baseSha) {
    throw new DraftConflictError(
      `Entwurf "${pageId}" wurde seit dem geladenen Stand bereits geändert.`,
      current.sha,
      current.content,
    )
  }

  // Stabile-id-Bewahrung an der Schreibquelle: Verliert der gespeicherte
  // Content das Frontmatter-`id`-Feld (Editor, Import, MCP), fiele die
  // main-Indexierung nach dem Merge auf eine pfadbasierte Fallback-Id zurück
  // und kollidierte beim inkrementellen Reindex mit dem
  // `(space,path,ref)`-Unique-Constraint — der Index veraltet dann STILL
  // (s. `@f451/markdown#ensureFrontmatterId`). Konsistent dazu setzt die
  // Draft-Indexierung unten die `id` ohnehin hart auf `pageId`.
  const contentWithId = ensureFrontmatterId(content, pageId)

  const commitMessage = message ?? `docs: ${title} (Entwurf)`
  try {
    await provider.writeFile(repo, pagePath, contentWithId, { branch, message: commitMessage, sha: baseSha })
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err
    // Race zwischen Vorab-Check und Schreiben (paralleler Save eines anderen
    // Nutzers zwischen den beiden Requests): Stand frisch nachladen, damit die
    // 409-Antwort den tatsächlich aktuellen Inhalt trägt, nicht den soeben
    // schon wieder veralteten Vorab-Check-Stand.
    const fresh = await provider.readFile(repo, pagePath, branch)
    throw new DraftConflictError(
      `Entwurf "${pageId}" wurde während des Speicherns von anderer Seite geändert.`,
      fresh.sha,
      fresh.content,
    )
  }

  await indexDraftPage(deps.db, space, pageId, pagePath, contentWithId)

  return { newSha: gitBlobSha1(contentWithId), savedAt: new Date().toISOString() }
}

/**
 * Inkrementelle Draft-Indexierung nach einem erfolgreichen Save (Plan Task 3):
 * dieselben 1c-Bausteine wie der main-Indexer (`buildPageInfo`/`upsertPage`
 * aus `indexer/index-space.ts`), aber NUR für genau diese eine Seite und mit
 * `ref='draft'`. Erzeugt bewusst KEINE Kanten/Tags (`replaceEdgesForPage`
 * bleibt Sache des main-Indexers) — Broken-Link-Heilung und Hierarchie sind
 * kein Autosave-Anliegen, die Draft-Suche braucht nur Titel/Text/Suchvektor.
 *
 * `buildPageInfo` leitet die Seiten-Id primär aus dem Frontmatter ab
 * (`frontmatter.id`); die `id` wird hier hart auf `pageId` überschrieben
 * (statt dem Frontmatter zu vertrauen) — sonst würde ein versehentlich im
 * Entwurf geändertes `id:`-Frontmatter die Draft-Indexzeile unter einer
 * ANDEREN Id ablegen und die Verbindung zur eigentlichen Seite (und damit zu
 * `clearDraftIndex`/der main-Zeile) verlieren.
 *
 * `upsertPage` benötigt einen `LinkResolver`, dessen Href-Auflösung hier nicht
 * relevant ist (nur der Suchindex zählt, kein Draft-Preview mit aufgelösten
 * Cross-Page-Links) — ein Resolver mit ausschließlich der gespeicherten Seite
 * genügt, Broken-Link-Zählung wird ignoriert (`replaceEdgesForPage` läuft
 * ohnehin nicht mit).
 */
export async function indexDraftPage(
  db: Db,
  space: SpaceConfig,
  pageId: string,
  pagePath: string,
  raw: string,
): Promise<void> {
  const info = buildPageInfo(space.id, pagePath, raw, space.defaultLang, space.name)
  const resolver = new LinkResolver([{ id: pageId, path: pagePath, title: info.title }])

  await db.transaction(async (tx) => {
    // indexTags: false — siehe `UpsertPageOptions`-Kommentar in index-space.ts:
    // `tags` hat keinen `ref` im Primärschlüssel, Draft-Tags könnten daher
    // Insert-Konflikte mit main-Tags auslösen oder über die main-Lese-API leaken.
    //
    // Issue #7: `upsertPage` verweigert das Schreiben (WHERE-Klausel im
    // `onConflictDoUpdate`, s. dort), wenn `(pageId, 'draft')` bereits einer
    // ANDEREN `space.id` gehört (zwei Spaces mit derselben Frontmatter-`id`) —
    // derselbe Schutz wie beim main-Voll-/Inkremental-Reindex, ohne Sonderfall
    // hier. Der Rückgabewert wird bewusst ignoriert: der Git-Commit auf dem
    // Draft-Branch ist in diesem Fall bereits geschrieben (s. `writeFile` oben),
    // nur der Such-/Vorschau-Indexeintrag bliebe dann aus — ableitbar, ein
    // Reindex holt ihn nach, sobald die Id-Kollision im Frontmatter behoben ist.
    await upsertPage(tx, space.id, 'draft', { ...info, id: pageId }, resolver, { indexTags: false })
  })
}
