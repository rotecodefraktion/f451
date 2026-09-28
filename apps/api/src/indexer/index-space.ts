import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { parsePage, renderHtml } from '@f451/markdown'
import type { GitFile, GitProvider } from '@f451/git-provider'
import type { PageFrontmatter, PageHeading, ExtractedLink } from '@f451/markdown'
import type { Db } from '../db/client.js'
import { edges, pages, spaces, tags } from '../db/schema.js'
import type { OpsCounters } from '../ops/counters.js'
import type { SpaceConfig } from '../spaces/config.js'
import { buildResolveImage, buildResolveLink, isMediaLink, LinkResolver, type ResolvablePage } from './resolve-links.js'
import { loadOrderKeysForPages } from './order-file.js'
import { reconstructMissingVersions } from './version-history.js'

/** Minimal-Logger-Vertrag (z. B. Fastifys `app.log` oder Pino), optional für
 *  `indexSpace`, damit übersprungene Dateien (F1) beobachtbar sind, ohne dass
 *  Aufrufer ohne Logger (z. B. Tests) etwas übergeben müssen. */
export interface IndexerLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void
}

export interface IndexerDeps {
  db: Db
  provider: GitProvider
  logger?: IndexerLogger
  /** Task 5 (Betrieb): erhöht `indexer_errors`, wenn `readPageFileSafe` unten
   *  eine Datei wegen eines transienten IO-/Netzwerkfehlers überspringen muss —
   *  optional, damit die zahlreichen Bestandsaufrufe (Tests, `incremental.ts`,
   *  `drift.ts`) ohne Zähler weiterlaufen. */
  counters?: OpsCounters
}

export interface IndexSpaceOptions {
  /** Zu indexierender Ref. Default 'main' (Leseansicht-Vertrag). */
  ref?: string
}

export interface IndexReport {
  pagesIndexed: number
  pagesWithErrors: number
  brokenLinks: number
  /** Dateien, deren `readFile` mit einem transienten IO/Netzwerk-Fehler abgebrochen
   *  ist und die deshalb komplett übersprungen wurden (F1): die bestehende
   *  Index-Zeile bleibt unangetastet. > 0 bedeutet, dass dieser Lauf unvollständig
   *  war — `indexedHeadSha` wurde deshalb NICHT auf den neuen HEAD gesetzt, damit
   *  ein Drift-Job den Lauf wiederholt. */
  filesSkippedIo: number
  headSha: string
}

/**
 * Transaktions-Handle, wie es `db.transaction(async (tx) => ...)` an den
 * Callback übergibt. Wird von den unten exportierten Bausteinen erwartet,
 * damit sie sowohl vom Voll-Reindex als auch vom inkrementellen Indexieren
 * (Task 4, `src/indexer/incremental.ts`) innerhalb derselben Transaktion
 * wiederverwendet werden können.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Interne, geparste Sicht auf eine Seite vor dem Schreiben. */
export interface PageInfo {
  id: string
  path: string
  title: string
  lang: string
  archived: boolean
  frontmatter: PageFrontmatter
  frontmatterErrors: string[]
  headings: PageHeading[]
  links: ExtractedLink[]
  relations: Record<string, string[]>
  tags: string[]
  raw: string
  errorStatus: 'parse_error' | null
}

/** Postgres-Textsuch-Konfiguration aus der Seiten-Sprache (Plan Global Constraints). */
export function tsConfig(lang: string): 'german' | 'english' | 'simple' {
  if (lang === 'de') return 'german'
  if (lang === 'en') return 'english'
  return 'simple'
}

/**
 * Leitet die Seiten-Id aus dem geparsten Frontmatter ab, mit Fallback auf den
 * Pfad (`path:<spaceId>/<filePath>`) — DIE EINE Formel, mit der jede main-
 * Indexierung (`buildPageInfo` unten), die Draft-Indexierung (`drafts/save.ts
 * #indexDraftPage`) und die Seitenanlage (Phase 2d Task 5, `drafts/create-page.ts`)
 * dieselbe Id für dieselbe Datei berechnen. Extrahiert (statt in `buildPageInfo`
 * inline zu bleiben), damit die Seitenanlage sie VOR dem ersten Schreiben
 * wiederverwenden kann, ohne die Formel zu duplizieren — eine abweichende Kopie
 * würde dazu führen, dass eine neu angelegte Seite nach ihrem ersten Release
 * (main-Indexierung berechnet die Id dann erneut, diesmal über `buildPageInfo`)
 * unter einer ANDEREN Id landet als der, unter der sie im Draft-Index bereits
 * stand — genau der Identitätswechsel, den Task 5 explizit ausschließen muss.
 */
export function derivePageId(spaceId: string, filePath: string, frontmatterId: string | undefined): string {
  return frontmatterId ?? `path:${spaceId}/${filePath}`
}

/** Leitet einen Anzeigetitel aus dem Dateipfad ab, wenn kein Titel vorhanden ist. */
export function deriveTitle(filePath: string, fallback: string): string {
  const segments = filePath.split('/')
  // Verzeichnisname der Seite (Segment vor 'index.md'); Wurzelseite → Fallback.
  if (segments.length >= 2) return segments[segments.length - 2]!
  return fallback
}

/** Extrahiert reinen Text aus gerendertem HTML für den Suchindex. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Ist der Baumeintrag eine zu indexierende Seiten-Datei (index.md, ggf. verschachtelt)? */
export function isPageFile(path: string, type: string): boolean {
  return type === 'file' && (path === 'index.md' || path.endsWith('/index.md'))
}

/**
 * Liest eine Seiten-Datei IO-fehlersicher (F1): liefert die vollständige
 * `GitFile` (Roh-Inhalt UND Blob-SHA, Task 5 — `pages.lastBlobSha`, s.
 * `UpsertPageOptions.lastBlobSha`-Kommentar, nutzt den hier ohnehin schon
 * gelesenen SHA statt eines zusätzlichen Provider-Aufrufs) oder `null` bei
 * einem (transienten) IO/Netzwerk-Fehler — der Fehler ist dann bereits über
 * den optionalen Logger gemeldet, und der Aufrufer MUSS die Datei komplett
 * überspringen (bestehende Index-Zeile unangetastet lassen) statt sie mit
 * leerem Inhalt weiterzuverarbeiten. Gemeinsamer Baustein für Voll-
 * (`indexSpace`) und Inkremental-Indexierung (`incremental.ts`), damit beide
 * Pfade dasselbe korrekte Leseverhalten haben.
 */
export async function readPageFileSafe(
  provider: GitProvider,
  space: SpaceConfig,
  filePath: string,
  ref: string,
  logger?: IndexerLogger,
  counters?: OpsCounters,
): Promise<GitFile | null> {
  try {
    return await provider.readFile(space.repoRef, filePath, ref)
  } catch (err) {
    logger?.warn(`indexer: readFile fehlgeschlagen, Datei übersprungen: ${filePath}`, {
      spaceId: space.id,
      path: filePath,
      ref,
      error: err instanceof Error ? err.message : String(err),
    })
    // Task 5 (Betrieb): echter Fehlerpfad (transienter IO-/Netzwerkfehler beim
    // Lesen, nicht bloß ein erwarteter/ignorierter Zustand) — zählt für ALLE
    // drei Aufrufer gleichermaßen (Voll-Reindex, inkrementelles Webhook-
    // Indexieren, Drift-Job-Reindex), da sie sich diese Funktion teilen.
    counters?.increment('indexer_errors')
    return null
  }
}

/** Parst den Roh-Inhalt einer Seiten-Datei zu einer `PageInfo` (Task 3/4-Baustein,
 *  gemeinsam genutzt von Voll- und Inkremental-Indexierung). Wirft nie — Parse-Fehler
 *  landen in `frontmatterErrors`/`errorStatus`, der Aufrufer bricht dadurch nie ab. */
export function buildPageInfo(
  spaceId: string,
  filePath: string,
  raw: string,
  defaultLang: string,
  fallbackTitle: string,
): PageInfo {
  const parsed = parsePage(raw)
  const errorStatus = parsed.frontmatterErrors.length > 0 ? 'parse_error' : null
  return {
    id: derivePageId(spaceId, filePath, parsed.frontmatter.id),
    path: filePath,
    title: parsed.title ?? deriveTitle(filePath, fallbackTitle),
    lang: parsed.frontmatter.lang ?? defaultLang,
    archived: parsed.frontmatter.archived ?? false,
    frontmatter: parsed.frontmatter,
    frontmatterErrors: parsed.frontmatterErrors,
    headings: parsed.headings,
    links: parsed.links,
    relations: parsed.frontmatter.relations,
    tags: parsed.frontmatter.tags,
    raw,
    errorStatus,
  }
}

export interface UpsertPageOptions {
  /**
   * Tags mit upserten (Default true, unverändertes Voll-/Inkremental-Verhalten).
   * `false` für die Draft-Indexierung (Phase 2a Task 3, `drafts/save.ts`):
   * `tags` hat NUR `PRIMARY KEY(page_id, tag)` — OHNE `ref` — daher können eine
   * main- und eine draft-Zeile mit demselben Tag-Namen nicht nebeneinander
   * existieren (Insert-Konflikt, `onConflictDoNothing` würde den Draft-Tag
   * dann still verwerfen); ein NEUER, nur im Entwurf vorhandener Tag-Name
   * würde dagegen unter `ref='draft'` landen und über die main-Lese-API
   * (`GET /api/pages/:id`, ohne `ref`-Filter auf `tags`) sichtbar leaken. Die
   * Draft-Suche braucht laut Plan ohnehin nur Titel/Text/Suchvektor — daher
   * hier bewusst übersprungen statt das Tags-Schema für einen ungenutzten
   * Anwendungsfall zu erweitern.
   */
  indexTags?: boolean
  /**
   * Autor des letzten main-Commits dieser Seite (Metadaten-Feature M3b Teil A,
   * `pages.lastAuthor`, s. Spaltenkommentar `db/schema.ts`) — vom AUFRUFER
   * ermittelt (i. d. R. `provider.listCommits`, s. `incremental.ts`), diese
   * Funktion selbst tut nie IO. DREI Zustände mit UNTERSCHIEDLICHER Wirkung:
   *  - `undefined` (nicht angegeben, Default): Spalte bleibt beim UPDATE
   *    UNANGETASTET (Voll-Reindex `index-space.ts#indexSpace` ermittelt keinen
   *    Autor — ein bereits bekannter Wert aus einer früheren inkrementellen
   *    Indexierung darf dadurch nicht verloren gehen); beim INSERT (neue Seite)
   *    wird `null` gespeichert.
   *  - `string`: expliziter neuer Autor, überschreibt einen evtl. vorhandenen.
   *  - `null`: explizit "unbekannt" (z. B. `listCommits` lieferte keinen
   *    Treffer/schlug fehl) — überschreibt einen evtl. vorhandenen Autor
   *    ebenfalls mit `null` (die Seite hat sich ja gerade geändert, ein alter
   *    Autor-Stand wäre falsch).
   */
  lastAuthor?: string | null
  /**
   * Blob-SHA der gelesenen Datei (Seitenversionierung Etappe 1, Task 5,
   * `pages.lastBlobSha`, s. Spaltenkommentar `db/schema.ts`) — vom AUFRUFER
   * ermittelt (der Provider liefert ihn beim Lesen als `GitFile.sha`, s.
   * `readPageFileSafe`), diese Funktion selbst tut nie IO. Bewusst der
   * Blob-SHA aus `/contents/{path}` (Dateiinhalt), NICHT der Commit-SHA des
   * Commits, der die Änderung eingebracht hat — nur ein Inhaltsvergleich
   * beantwortet "hat sich der Inhalt seit der Freigabe geändert?" richtig,
   * ein Commit-Vergleich schlüge auch bei Commits an, die diese Datei gar
   * nicht berühren. GENAU DASSELBE Drei-Zustands-Muster wie `lastAuthor`
   * oben — mit EINEM Unterschied (Befund 1, Final-Review): der Voll-Reindex
   * gehört NICHT mehr zu den Aufrufern, die `undefined` übergeben. Er hat
   * `file.sha` beim ohnehin nötigen Lesen jeder Seite bereits in der Hand
   * (`index-space.ts#indexSpace`, kein zusätzlicher Provider-Aufruf) und ist
   * damit die BESSERE, nicht die schlechtere Quelle — er übergibt daher IMMER
   * den frisch gelesenen SHA (analog zu `orderKey` unten). Das Drei-Zustands-
   * Muster bleibt für Aufrufer erhalten, die den SHA tatsächlich nicht kennen:
   *  - `undefined` (nicht angegeben, Default): Spalte bleibt beim UPDATE
   *    UNANGETASTET — ein bereits bekannter Wert aus einer früheren
   *    inkrementellen Indexierung darf dadurch nicht verloren gehen; beim
   *    INSERT (neue Seite) wird `null` gespeichert.
   *  - `string`: expliziter neuer SHA, überschreibt einen evtl. vorhandenen.
   *  - `null`: explizit „unbekannt" — überschreibt einen evtl. vorhandenen SHA
   *    ebenfalls mit `null`.
   */
  lastBlobSha?: string | null
  /**
   * Geschwister-Reihenfolge (Phase 3.3, `pages.orderKey`, s. Spaltenkommentar
   * `db/schema.ts`) — GENAU DASSELBE Drei-Zustands-Muster wie `lastAuthor`
   * oben:
   *  - `undefined` (Default): Spalte bleibt beim UPDATE UNANGETASTET. Die
   *    inkrementelle Indexierung (`incremental.ts`) übergibt bewusst NICHTS,
   *    weil ein `.order`-Datei-Commit KEINEN Webhook-Reindex einer `index.md`
   *    auslöst (`.order` ist keine Seiten-Datei, `isPageFile`) — ein bereits
   *    bekannter `orderKey` darf durch einen unrelated Seiten-Push (z. B.
   *    Tippfehler-Korrektur) nicht verloren gehen. Beim INSERT (neue Seite)
   *    wird `null` gespeichert (kein `.order`-Eintrag bekannt).
   *  - `number`: expliziter neuer `orderKey`, überschreibt einen evtl.
   *    vorhandenen.
   *  - `null`: explizit „kein Eintrag in der `.order`-Datei" — überschreibt
   *    einen evtl. vorhandenen Wert (die Seite wurde aus der `.order`-Datei
   *    entfernt oder es gibt gar keine).
   *
   * Der Voll-Reindex (`index-space.ts#indexSpace`) übergibt IMMER einen
   * expliziten Wert (`number` oder `null`), nie `undefined` — er berechnet
   * `orderKey` bei JEDEM Lauf frisch aus den `.order`-Dateien
   * (`order-file.ts#loadOrderKeysForPages`), verwirft ihn also nie
   * stillschweigend (Spec-Vorgabe Phase 3.3).
   */
  orderKey?: number | null
}

/**
 * Rendert HTML (mit aufgelösten Hrefs/Medien) und upsertet eine Seite inkl.
 * Suchvektor und (optional) Tags. Gemeinsamer Baustein für Voll- und
 * Inkremental-Indexierung sowie die Draft-Indexierung (Task 3, ohne Tags).
 */
export async function upsertPage(
  tx: Tx,
  spaceId: string,
  ref: string,
  p: PageInfo,
  resolver: LinkResolver,
  opts?: UpsertPageOptions,
): Promise<{ html: string; plain: string }> {
  // `resolveLink`/`resolveImage`: geteilte Konstruktion (`resolve-links.ts`, Finding 2
  // Fix-Runde 1) — dieselben Callbacks nutzt auch `GET /review` (`routes/workflow.ts`),
  // damit beide Aufrufer garantiert dieselbe Auflösung verwenden statt einer Kopie,
  // die auseinanderlaufen kann. Bild-Pfadregel siehe Kommentar in `buildResolveImage`.
  const resolveLink = buildResolveLink(resolver, p.path, spaceId, p.id)
  const resolveImage = buildResolveImage(p.id)

  let html = ''
  try {
    html = renderHtml(p.raw, { resolveLink, resolveImage })
  } catch {
    html = ''
  }
  // Fehlerseiten: Rohtext als durchsuchbaren plainText (Spec Abschnitt 9).
  const plain = p.errorStatus ? p.raw : htmlToPlainText(html)
  const now = new Date()

  await tx
    .insert(pages)
    .values({
      id: p.id,
      spaceId,
      path: p.path,
      ref,
      title: p.title,
      frontmatter: p.frontmatter,
      frontmatterErrors: p.frontmatterErrors,
      headings: p.headings,
      plainText: plain,
      htmlRendered: html,
      lang: p.lang,
      archived: p.archived,
      errorStatus: p.errorStatus,
      updatedAt: now,
      lastAuthor: opts?.lastAuthor ?? null,
      lastBlobSha: opts?.lastBlobSha ?? null,
      orderKey: opts?.orderKey ?? null,
    })
    .onConflictDoUpdate({
      // Zusammengesetzter Konflikt-Ziel-Schlüssel (Phase 2a Task 3): `pages` hat
      // seit der Draft-Indexierung keinen alleinstehenden Primärschlüssel mehr
      // auf `id` (dieselbe Id existiert als ref='main'- UND ref='draft'-Zeile),
      // sondern `(id, ref)` — der ON-CONFLICT-Ziel muss dem entsprechen, sonst
      // würde Postgres beim Speichern eines Drafts (gleiche Id, ref='draft')
      // die BESTEHENDE main-Zeile treffen und ihren ref auf 'draft' überschreiben
      // (stiller Verlust des main-Index-Eintrags).
      target: [pages.id, pages.ref],
      set: {
        spaceId,
        path: p.path,
        ref,
        title: p.title,
        frontmatter: p.frontmatter,
        frontmatterErrors: p.frontmatterErrors,
        headings: p.headings,
        plainText: plain,
        htmlRendered: html,
        lang: p.lang,
        archived: p.archived,
        errorStatus: p.errorStatus,
        updatedAt: now,
        // `opts.lastAuthor === undefined` (Voll-Reindex, s. `UpsertPageOptions`-
        // Kommentar): Spalte per Selbst-Referenz unangetastet lassen (Postgres
        // liest den Ausdruck rechts gegen die BESTEHENDE Zeile vor dem Update)
        // statt einen ggf. bereits bekannten Autor mit `null` zu überschreiben.
        lastAuthor: opts?.lastAuthor !== undefined ? opts.lastAuthor : sql`${pages.lastAuthor}`,
        // `opts.lastBlobSha === undefined`: Spalte per Selbst-Referenz
        // unangetastet lassen, exakt wie bei `lastAuthor` oben — der Voll-Reindex
        // übergibt seit Befund 1 (Final-Review) NIE mehr `undefined` (s.
        // `UpsertPageOptions.lastBlobSha`-Kommentar), dieser Zweig greift nur noch
        // für Aufrufer, die den SHA tatsächlich nicht kennen.
        lastBlobSha:
          opts?.lastBlobSha !== undefined ? opts.lastBlobSha : sql`${pages.lastBlobSha}`,
        // `opts.orderKey === undefined` (inkrementelle Indexierung, s.
        // `UpsertPageOptions.orderKey`-Kommentar): Spalte per Selbst-Referenz
        // unangetastet lassen, exakt wie bei `lastAuthor` oben.
        orderKey: opts?.orderKey !== undefined ? opts.orderKey : sql`${pages.orderKey}`,
      },
    })

  // Suchvektor explizit (Sprachwahl pro Zeile, Plan Global Constraints). WHERE
  // filtert zusätzlich auf `ref` (Phase 2a Task 3): seit derselben Id für
  // ref='main' UND ref='draft' zwei Zeilen existieren können, würde ein reines
  // `where id = ...` BEIDE treffen und den main-Suchvektor mit dem gerade
  // gespeicherten Draft-Inhalt überschreiben (durch das darüberliegende
  // `onConflictDoUpdate` selbst bereits korrekt ref-scoped, dieses separate
  // UPDATE aber nicht) — genau der stille Verlust, den die Draft-Indexierung
  // laut Plan Global Constraints ausschließen muss.
  const config = tsConfig(p.lang)
  await tx.execute(sql`
    update pages set search_vector =
      setweight(to_tsvector(${config}::regconfig, ${p.title}), 'A') ||
      setweight(to_tsvector(${config}::regconfig, ${plain}), 'B') ||
      setweight(to_tsvector('simple'::regconfig, ${`${p.title} ${plain}`}), 'C')
    where id = ${p.id} and ref = ${ref}
  `)

  // Tags ersetzen — ref-scoped UND abschaltbar (Phase 2a Task 3, siehe
  // `UpsertPageOptions.indexTags`-Kommentar): ohne den `ref`-Filter würde
  // `delete` die main-Tags derselben Id mitlöschen und der `insert` sie unter
  // der main-Zeile ablegen.
  if (opts?.indexTags ?? true) {
    await tx.delete(tags).where(and(eq(tags.pageId, p.id), eq(tags.ref, ref)))
    const uniqueTags = [...new Set(p.tags)]
    if (uniqueTags.length > 0) {
      await tx
        .insert(tags)
        .values(uniqueTags.map((tag) => ({ pageId: p.id, tag, ref })))
        .onConflictDoNothing()
    }
  }

  return { html, plain }
}

/**
 * Ersetzt alle ausgehenden Kanten einer Seite (Links, Relations, Hierarchie),
 * zwei-Pass-aufgelöst über den übergebenen `resolver`. Gemeinsamer Baustein
 * für Voll- und Inkremental-Indexierung. Liefert die Anzahl neu entstandener
 * Broken Links (toPageId null) dieser Seite — dedupliziert über dieselbe
 * `seen`-Logik wie die Kanten selbst (F2), damit ein mehrfach vorkommender
 * kaputter Link (gleiches rawTarget/type/label) nicht mehrfach gezählt wird.
 */
export async function replaceEdgesForPage(
  tx: Tx,
  p: PageInfo,
  resolver: LinkResolver,
): Promise<number> {
  await tx.delete(edges).where(eq(edges.fromPageId, p.id))

  const rows: Array<{
    fromPageId: string
    toPageId: string | null
    rawTarget: string
    type: string
    label: string
    ref: string
  }> = []
  const seen = new Set<string>()
  const push = (rawTarget: string, type: string, label: string, toPageId: string | null): void => {
    const key = `${type} ${rawTarget} ${label}`
    if (seen.has(key)) return
    seen.add(key)
    // `ref` explizit statt Spalten-Default (P1-Fix Phase 2a/2d Task 1): die
    // Spalte ist jetzt NOT NULL, der Default bliebe zwar weiterhin 'main', aber
    // ein expliziter Wert macht die Absicht hier lesbar und ist unabhängig vom
    // DB-Default korrekt, falls der sich je ändert.
    rows.push({ fromPageId: p.id, toPageId, rawTarget, type, label, ref: 'main' })
  }

  // Links (Wikilinks + relative Links). Anhang-Links (`_media/…`, relativ) sind
  // Datei- statt Seiten-Verweise — sie werden hier übersprungen, statt als
  // (immer kaputte) Seiten-Kante angelegt zu werden (Bugfix Live-Betrieb:
  // dieselbe `isMediaLink`-Bedingung wie `buildResolveLink`, s. dort — sonst
  // zählt der Broken-Link-Report Anhänge weiterhin als „nicht auflösbar",
  // obwohl die Leseansicht sie längst korrekt verlinkt).
  for (const link of p.links) {
    if (link.kind === 'relative' && isMediaLink(link.rawTarget)) continue
    const tid = resolver.resolve(link.rawTarget, link.kind, p.path)
    push(link.rawTarget, 'link', '', tid)
  }
  // Relations (Label = Relations-Typ).
  for (const [relType, targets] of Object.entries(p.relations)) {
    for (const target of targets) {
      push(target, 'relation', relType, resolver.resolveRelation(target))
    }
  }
  // Hierarchie (Verzeichnisstruktur).
  const parent = resolver.parentOf(p.path)
  if (parent && parent.id !== p.id) {
    push(parent.path, 'hierarchy', '', parent.id)
  }

  if (rows.length > 0) {
    await tx.insert(edges).values(rows).onConflictDoNothing()
  }

  // Zähler == Anzahl Broken-Kanten (F2): erst NACH der Dedup-Logik oben zählen,
  // sonst würde ein doppelt vorkommender kaputter Link mehrfach gezählt, obwohl
  // nur eine Kante entsteht.
  return rows.filter((r) => r.type === 'link' && r.toPageId === null).length
}

/**
 * Voll-Reindex eines Space gegen den `main`-Ref. Idempotent: zweimal hintereinander
 * ausgeführt (ohne IO-Fehler) ergibt denselben DB-Zustand (bis auf `pages.updatedAt`).
 *
 * Ablauf:
 * 1. Space-Zeile upserten, HEAD-SHA und Baum vom Provider holen.
 * 2. Alle index.md-Dateien lesen und parsen. Parse-Fehler (kaputtes YAML etc.)
 *    brechen den Batch nicht — Seite bekommt `errorStatus='parse_error'` + Rohtext
 *    als plainText. Transiente IO/Netzwerk-Fehler beim Lesen selbst sind davon
 *    bewusst getrennt (F1): die betroffene Datei wird komplett übersprungen statt
 *    die Seite mit leerem Inhalt zu überschreiben — die bestehende Index-Zeile
 *    bleibt unangetastet, der Fehler zählt in `filesSkippedIo` und wird geloggt.
 * 3. Seiten, die im Index stehen aber nicht mehr im Repo-Baum sind UND nicht wegen
 *    eines IO-Fehlers übersprungen wurden, löschen (eingehende Kanten degradieren
 *    per SET NULL zu Broken Links — wird durch die Neu-Auflösung unten aktiv
 *    sichergestellt).
 * 4. Alle erfolgreich gelesenen Seiten upserten (HTML mit aufgelösten Hrefs,
 *    Suchvektor, Tags).
 * 5. Kanten je erfolgreich gelesener Seite ersetzen (Links/Relations/Hierarchie),
 *    zwei-Pass-aufgelöst — der Resolver kennt dafür auch übersprungene Seiten
 *    (aus dem bestehenden DB-Stand), damit Links AUF sie nicht fälschlich brechen.
 * 6. `indexedHeadSha` NUR setzen, wenn keine Datei übersprungen wurde — sonst war
 *    der Lauf unvollständig und ein Drift-Job soll ihn wiederholen.
 */
export async function indexSpace(
  deps: IndexerDeps,
  space: SpaceConfig,
  opts?: IndexSpaceOptions,
): Promise<IndexReport> {
  const { db, provider, logger, counters } = deps
  const ref = opts?.ref ?? 'main'

  const headSha = await provider.getHeadSha(space.repoRef, ref)
  const tree = await provider.listTree(space.repoRef, ref)
  const pageFiles = tree.filter((e) => isPageFile(e.path, e.type)).map((e) => e.path)

  // --- Lesen + Parsen (Pass 1) --------------------------------------------------
  const pageInfos: PageInfo[] = []
  const ioSkippedPaths: string[] = []
  // Blob-SHA der gelesenen Fassung je Seite (Befund 1, Final-Review): der
  // Voll-Reindex hat `file.sha` beim ohnehin nötigen `readPageFileSafe`-Aufruf
  // bereits in der Hand (kein zusätzlicher Provider-Aufruf) — er ist damit die
  // BESSERE Quelle für `pages.lastBlobSha`, nicht die schlechtere. Vorher gab
  // der Voll-Reindex bewusst `undefined` weiter (Spalte blieb unangetastet), mit
  // der Begründung, sonst erschiene jede Seite nach jedem Voll-Reindex fälschlich
  // als "geändert" — das gilt aber nur fürs Schreiben von `null`, nicht fürs
  // Schreiben des ECHTEN, gerade gelesenen SHA. Fehlerszenario, das der alte Code
  // zuließ: Seite ist als 1.1.0 freigegeben, jemand committet direkt auf `main`
  // (Webhook fällt aus/ist nicht konfiguriert), stattdessen läuft `POST
  // /admin/reindex` — der Voll-Reindex aktualisiert Inhalt und HTML, ließ
  // `lastBlobSha` aber auf dem alten Wert stehen → die Leseansicht zeigte den
  // NEUEN Inhalt unter der ALTEN Versionsnummer OHNE den Hinweis "geändert seit
  // X". Das Drei-Zustands-Muster (`UpsertPageOptions.lastBlobSha`-Kommentar)
  // bleibt für Aufrufer bestehen, die den SHA wirklich nicht kennen (z. B. ein
  // künftiger Aufrufer ohne `GitFile`) — der Voll-Reindex gehört ab jetzt nicht
  // mehr dazu, er übergibt immer den frisch gelesenen SHA.
  const lastBlobShaByPath = new Map<string, string>()
  for (const filePath of pageFiles) {
    const file = await readPageFileSafe(provider, space, filePath, ref, logger, counters)
    if (file === null) {
      // Transienter IO/Netzwerk-Fehler beim Lesen (F1, bereits geloggt): Datei
      // komplett überspringen statt die Seite mit raw='' still zu leeren. Bestehende
      // Index-Zeile bleibt unangetastet — der Pfad wird unten aus dem Delete-Set
      // ausgenommen.
      ioSkippedPaths.push(filePath)
      continue
    }
    lastBlobShaByPath.set(filePath, file.sha)
    pageInfos.push(buildPageInfo(space.id, filePath, file.content, space.defaultLang, space.name))
  }

  // Resolver braucht auch die übersprungenen Seiten (aus dem bestehenden DB-Stand),
  // damit andere Seiten weiterhin korrekt auf sie verlinken können (F1).
  let resolverPages: readonly ResolvablePage[] = pageInfos
  if (ioSkippedPaths.length > 0) {
    const existingSkipped = await db
      .select({ id: pages.id, path: pages.path, title: pages.title })
      .from(pages)
      .where(
        and(eq(pages.spaceId, space.id), eq(pages.ref, ref), inArray(pages.path, ioSkippedPaths)),
      )
    resolverPages = [...pageInfos, ...existingSkipped]
  }

  const resolver = new LinkResolver(resolverPages)
  const currentIds = pageInfos.map((p) => p.id)
  let brokenLinks = 0

  // `.order`-Dateien (Phase 3.3): je erfolgreich gelesener Seite den `orderKey`
  // NEU aus der `.order`-Datei ihres Elternverzeichnisses berechnen — der
  // Voll-Reindex verwirft eine bereits gesetzte Reihenfolge NIE stillschweigend,
  // sondern rekonstruiert sie bei JEDEM Lauf frisch (Spec-Vorgabe). IO-fehler-
  // bedingt übersprungene Seiten (`ioSkippedPaths`) sind hier bewusst NICHT
  // dabei — ihre Zeile bleibt unangetastet (F1), `upsertPage` wird für sie in
  // diesem Lauf ohnehin nicht aufgerufen.
  const orderKeys = await loadOrderKeysForPages(
    provider,
    space.repoRef,
    ref,
    pageInfos.map((p) => ({ id: p.id, path: p.path })),
    resolver,
    logger,
  )

  await db.transaction(async (tx) => {
    // Space-Zeile upserten (FK-Ziel für pages.spaceId).
    await tx
      .insert(spaces)
      .values({
        id: space.id,
        provider: space.provider,
        owner: space.owner,
        repo: space.repo,
        name: space.name,
        defaultLang: space.defaultLang,
      })
      .onConflictDoUpdate({
        target: spaces.id,
        set: {
          provider: space.provider,
          owner: space.owner,
          repo: space.repo,
          name: space.name,
          defaultLang: space.defaultLang,
        },
      })

    // Verschwundene Seiten löschen (vor dem Upsert — gibt UNIQUE(space,path,ref)
    // für ggf. umbenannte Seiten frei; eingehende Kanten → SET NULL = Broken Link).
    // Wegen eines IO-Fehlers übersprungene Pfade werden explizit ausgenommen (F1):
    // deren Index-Zeile bleibt unangetastet, auch wenn ihre Id (noch) unbekannt ist.
    if (currentIds.length === 0 && ioSkippedPaths.length === 0) {
      await tx.delete(pages).where(and(eq(pages.spaceId, space.id), eq(pages.ref, ref)))
    } else {
      const exclusions = []
      if (currentIds.length > 0) exclusions.push(notInArray(pages.id, currentIds))
      if (ioSkippedPaths.length > 0) exclusions.push(notInArray(pages.path, ioSkippedPaths))
      await tx
        .delete(pages)
        .where(and(eq(pages.spaceId, space.id), eq(pages.ref, ref), ...exclusions))
    }

    // --- Seiten upserten (Pass 1b: HTML, Suchvektor, Tags, orderKey) ------------
    for (const p of pageInfos) {
      await upsertPage(tx, space.id, ref, p, resolver, {
        orderKey: orderKeys.get(p.id) ?? null,
        // Befund 1 (Final-Review): der frisch gelesene SHA aus Pass 1 — der
        // Voll-Reindex ist damit die bessere, nicht die schlechtere Quelle
        // für `lastBlobSha` (s. Kommentar über der Map oben für das WARUM).
        lastBlobSha: lastBlobShaByPath.get(p.path) ?? null,
      })
    }

    // --- Kanten ersetzen (Pass 2: alle Seiten existieren jetzt) -----------------
    for (const p of pageInfos) {
      brokenLinks += await replaceEdgesForPage(tx, p, resolver)
    }

    // indexedHeadSha nur bei vollständigem Lauf vorrücken (F1): gab es IO-Fehler,
    // bleibt der alte Stand stehen, damit ein Drift-Job den Lauf wiederholt.
    if (ioSkippedPaths.length === 0) {
      await tx.update(spaces).set({ indexedHeadSha: headSha }).where(eq(spaces.id, space.id))
    }
  })

  // Seitenversionierung Etappe 2: fehlende `page_versions`-Einträge aus der
  // Git-Historie nachtragen — nach der Transaktion, weil die Einträge an
  // `spaces` hängen und ein Provider-Aussetzer hier den Index nicht kippen darf.
  if (ref === 'main') {
    await reconstructMissingVersions(
      { db, provider, logger },
      space,
      pageInfos.map((p) => ({ id: p.id, path: p.path, version: p.frontmatter.version })),
    )
  }

  return {
    pagesIndexed: pageInfos.length,
    pagesWithErrors: pageInfos.filter((p) => p.errorStatus !== null).length,
    brokenLinks,
    filesSkippedIo: ioSkippedPaths.length,
    headSha,
  }
}
