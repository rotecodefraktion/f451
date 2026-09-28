import nodePath from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { joinFrontmatter, parsePage, setFrontmatterMetadata, splitFrontmatter } from '@f451/markdown'
import type { FileChange, GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { edges, locks, pages } from '../db/schema.js'
import type { SpaceConfig } from '../spaces/config.js'
import { derivePageId, deriveTitle, isPageFile } from '../indexer/index-space.js'
import { indexChangedFiles } from '../indexer/incremental.js'
import { ORDER_FILENAME, orderFilePath, parseOrderFile, serializeOrderFile } from '../indexer/order-file.js'
import { isMediaLink } from '../indexer/resolve-links.js'
import { branchExists, LOCK_TTL_MS } from './lifecycle.js'
import { draftBranchName } from './branch-name.js'
import { mediaDirFor } from './upload.js'
import {
  directoryOf,
  findByRefFallback,
  InvalidTitleError,
  normalizeTitle,
  PageCollisionError,
  ParentPageNotFoundError,
  pathSegmentFromTitle,
} from './create-page.js'

export { InvalidTitleError, PageCollisionError, ParentPageNotFoundError } from './create-page.js'

/**
 * Seite verschieben/umbenennen (Phase 3.2): git-nativ — eine Seite IST
 * `<pfad>/index.md`, Verschieben/Umbenennen ändert daher den Dateipfad
 * (Frontmatter/Inhalt bleiben ansonsten 1:1 byte-identisch, inkl. der
 * stabilen `id` aus Phase 3.1 — URL, Draft-Branch-Name, Lock und `edges`
 * bleiben dadurch über den Move hinweg stabil). Rename = neuer
 * `pathSegmentFromTitle(title)` unter demselben Elternverzeichnis; Move =
 * anderes Elternverzeichnis (`parentId`); beides gleichzeitig ist erlaubt.
 *
 * Da URLs id-basiert sind (`p-...`), ist der Pfad-Slug nahezu unsichtbar —
 * der sichtbare Seitenname IST der Frontmatter-`title`. Ein Rename (`title`
 * übergeben) schreibt den neuen Titel deshalb ZUSÄTZLICH zum Slug ins
 * Frontmatter der PRIMÄRSEITE (`withUpdatedTitle`, via `@f451/markdown`s
 * `setFrontmatterMetadata` — derselbe Schreibpfad wie das Titelfeld im
 * Editor, `editor-root.tsx`); die stabile `id` bleibt dabei unverändert. Ein
 * reiner Move (nur `parentId`) lässt das Frontmatter unangetastet.
 *
 * Rekursiv (Design-Vorgabe Phase 3.2): ALLE `index.md`-Seiten unter dem
 * Quellverzeichnis (samt `_media` UND verschachtelter `.order`-Dateien, s. u.)
 * wandern mit, jede behält ihre eigene, stabile `id` — nur ihr Pfad ändert
 * sich (Präfix-Ersetzung Quellverzeichnis → Zielverzeichnis); der neue Titel
 * gilt NUR für die Primärseite, NICHT für mitverschobene Unterseiten (deren
 * Titel bleiben unverändert). Eingehende Wikilinks auf JEDE bewegte Seite
 * werden automatisch umgeschrieben (nur pfadförmige `[[...]]`-Targets, s.
 * {@link isPathFormTarget}/{@link replaceWikiLinkTarget} unten).
 *
 * Nachschärfung (nach Phase 3.2): auch RELATIVE Markdown-Links (`](../x/
 * index.md)`) werden umgeschrieben — sowohl eingehend (Referenzierer, die per
 * relativem Link auf eine bewegte Seite zeigen, s. {@link normalizeRelativeTarget}/
 * {@link matchMovedPage}/{@link replaceRelativeLinkTarget}) als auch AUSGEHEND
 * innerhalb jeder bewegten Seite selbst (deren eigene relative Links müssen neu
 * berechnet werden, weil sich ihr eigenes Verzeichnis verschoben hat — s.
 * {@link relativeLinkTarget}). Abgedeckt: Ziel ist eine andere Seite (bewegt
 * oder nicht), Anker-Suffix bleibt erhalten, `.md`-Stil (mit/ohne Suffix)
 * bleibt erhalten. NICHT angefasst: absolute URLs/`mailto:`/reine Anker
 * (bereits beim Parsen ausgeschlossen, `packages/markdown/src/parse.ts#
 * isExcludedUrl`) sowie relative Links auf `_media/…` (eigene Anhänge wandern
 * 1:1 mit der Seite mit, ihr relativer Pfad bleibt unverändert gültig — s.
 * {@link isMediaLink}).
 *
 * Ebenfalls nachgeschärft: die `.order`-Datei des Eltern-Ordners (Baum-
 * Reihenfolge, `indexer/order-file.ts`) wird beim Move der id der PRIMÄRSEITE
 * gepflegt — aus der `.order` des alten Elternordners entfernt, an die `.order`
 * des neuen Elternordners angehängt (nur falls diese bereits existiert, sonst
 * bleibt die verschobene Seite unsortiert/alphabetisch — es wird KEINE neue
 * `.order`-Datei allein für sie angelegt). Bei einem reinen Rename (derselbe
 * Elternordner) bleibt die `.order`-Datei unangetastet, weil die id (stabil)
 * dort weiterhin gültig ist. `.order`-Dateien INNERHALB des verschobenen
 * Verzeichnisses (die Reihenfolge der Unterseiten) werden wie `_media` als
 * Teil des Multi-File-Moves mitkopiert, damit die Unterseiten-Reihenfolge den
 * Move übersteht.
 *
 * Die Space-Wurzelseite (`index.md` an der Space-Wurzel, `sourceDir === ''`)
 * darf weder verschoben noch umbenannt werden ({@link RootPageMoveError}) —
 * sie ist der Einstiegspunkt des Space, ein Move würde den gesamten Space
 * unter einen Unterordner ziehen.
 */

export interface MovePageDeps {
  db: Db
  /** Injectbare Uhr (Default: Date.now) — für deterministische Lock-TTL-Tests,
   *  dasselbe Muster wie `DraftLifecycleDeps.now` (`drafts/lifecycle.ts`). */
  now?: () => number
}

export interface MovePageInput {
  /** Neuer Titel (Rename) — der Zielpfad-Slug wird aus `pathSegmentFromTitle`
   *  abgeleitet (wie bei der Seitenanlage). Ohne `title` bleibt der aktuelle
   *  Pfad-Slug erhalten (reines Verschieben unter einen anderen Parent). */
  title?: string
  /** Ziel-Elternseite (Move). `undefined` = Elternverzeichnis unverändert
   *  (reines Umbenennen); `null` = an die Space-Wurzel verschieben; ein
   *  String referenziert eine bestehende Seite (main ODER draft-only) als
   *  neuen Elternknoten. */
  parentId?: string | null
}

export interface MovePageResult {
  /** Unverändert (Phase 3.1: stabile Id übersteht den Move). */
  id: string
  space: string
  /** Neuer Pfad der verschobenen/umbenannten Seite (Primärseite des Aufrufs). */
  path: string
  /** Anzahl der (samt Unterseiten) tatsächlich verschobenen Seiten. */
  movedCount: number
}

/** Blockiert den gesamten Move (409), weil die zu verschiebende Seite ODER
 *  eine ihrer Unterseiten einen offenen Draft/Review ODER einen aktiven Lock
 *  hat (Design-Vorgabe 4: „erst Review abschließen oder Entwurf verwerfen"). */
export class MoveBlockedError extends Error {
  constructor(
    message: string,
    public readonly blockedPageIds: readonly string[],
  ) {
    super(message)
    this.name = 'MoveBlockedError'
  }
}

/** Der gewählte Ziel-Parent liegt INNERHALB des zu verschiebenden Verzeichnisses
 *  selbst (oder ist die zu verschiebende Seite) — ein Move dorthin wäre ein
 *  Zyklus (die Seite würde ihr eigener Vorfahre). */
export class CircularMoveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircularMoveError'
  }
}

/** Die zu verschiebende/umzubenennende Seite ist die Space-Wurzelseite
 *  (`index.md` direkt an der Space-Wurzel, kein Elternverzeichnis) — sie ist
 *  der Einstiegspunkt des gesamten Space, ein Move würde den kompletten Space
 *  unter einen Unterordner ziehen. Wird VOR jeglichem Schreibvorgang geprüft. */
export class RootPageMoveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootPageMoveError'
  }
}

/** true, wenn `pagePath` unter `sourceDir` liegt (das Verzeichnis selbst
 *  eingeschlossen) — `sourceDir === ''` (Space-Wurzel) matcht per Definition
 *  JEDE Seite des Space (jede Seite liegt irgendwo unter der Wurzel). */
function isUnderSourceDir(pagePath: string, sourceDir: string): boolean {
  if (sourceDir === '') return true
  return pagePath === `${sourceDir}/index.md` || pagePath.startsWith(`${sourceDir}/`)
}

/** Das ELTERNVERZEICHNIS eines (bereits von `index.md` befreiten) Seiten-
 *  Verzeichnisses — NICHT zu verwechseln mit `sourceDir` selbst (das ist die
 *  Seite/das Verzeichnis, das verschoben wird): `parentDirOf('a/b')` → `'a'`,
 *  `parentDirOf('a')` → `''` (Space-Wurzel). Gebraucht für reines Umbenennen
 *  (`parentId` fehlt — Elternverzeichnis bleibt UNVERÄNDERT, nur der
 *  Pfad-Slug wechselt; `targetParentDir` ist dann dieses aktuelle
 *  Elternverzeichnis, NICHT `sourceDir`, sonst würde die Seite fälschlich
 *  unter ihr eigenes altes Verzeichnis geschachtelt). */
function parentDirOf(dir: string): string {
  const slash = dir.lastIndexOf('/')
  return slash === -1 ? '' : dir.slice(0, slash)
}

/** Ersetzt den `sourceDir`-Präfix eines Pfads durch `targetDir` — die
 *  rekursive Move-Regel (Design-Vorgabe 2): jede Unterseite behält ihren
 *  Pfad-REST relativ zum Quellverzeichnis, nur das Präfix wechselt. */
function rewritePath(oldPath: string, sourceDir: string, targetDir: string): string {
  if (sourceDir === '') return `${targetDir}/${oldPath}`
  if (oldPath === `${sourceDir}/index.md`) return `${targetDir}/index.md`
  return `${targetDir}/${oldPath.slice(sourceDir.length + 1)}`
}

/** Leitet das Wikilink-Ziel für eine Seite aus ihrem (neuen) Pfad ab — exakt
 *  dieselbe Regel wie `deriveWikiLinkTarget` (`apps/web/lib/editor/wiki-
 *  suggest.ts:90-98`, dort für die Editor-Autocomplete-Serialisierung): das
 *  Verzeichnis ohne `/index.md`, an der Space-Wurzel (kein Verzeichnisanteil)
 *  der Titel. Dupliziert statt importiert — `apps/web` und `apps/api` teilen
 *  keine gemeinsame Package-Grenze für UI-nahe Ableitungen. */
function wikiTargetForPath(path: string, title: string): string {
  const dir = path.replace(/(^|\/)index\.md$/, '')
  return dir.length === 0 ? title : dir
}

/** Trennt einen `#anchor`-Suffix vom Rest eines Wikilink-Rohziels ab. */
function splitAnchor(rawTarget: string): { base: string; anchor: string } {
  const hash = rawTarget.indexOf('#')
  return hash === -1 ? { base: rawTarget, anchor: '' } : { base: rawTarget.slice(0, hash), anchor: rawTarget.slice(hash) }
}

/**
 * Prüft, ob ein Wikilink-Rohziel PFADFÖRMIG exakt auf `pagePath` zeigt —
 * dieselbe Auflösungsregel wie `LinkResolver#resolveWikilink`
 * (`apps/api/src/indexer/resolve-links.ts:72-83`), hier isoliert
 * nachgebildet, weil wir NICHT auflösen (welche Id?), sondern nur
 * feststellen wollen, ob DIESES konkrete Rohziel ein Pfad-Match auf die
 * ALTE Seite war (und damit umgeschrieben werden muss) oder ein Titel-Match
 * (Design-Vorgabe 3: „titelbasierte NICHT anfassen" — die bleiben unverändert
 * korrekt, weil Titel sich beim Move nicht ändert).
 */
function isPathFormTarget(rawTarget: string, pagePath: string): boolean {
  const { base } = splitAnchor(rawTarget)
  const target = base.trim()
  if (target.length === 0) return false
  const cleaned = target.replace(/^\.?\//, '').replace(/\/+$/, '')
  const pathKey = cleaned.endsWith('/index.md') || cleaned === 'index.md' ? cleaned : `${cleaned}/index.md`
  return pathKey === pagePath
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Schreibt JEDES Vorkommen von `[[oldRawTarget]]`/`[[oldRawTarget|Alias]]` im
 *  Roh-Markdown auf `[[newRawTarget]]`/`[[newRawTarget|Alias]]` um — ein
 *  ggf. vorhandener `|Alias`-Teil bleibt UNVERÄNDERT (Design-Vorgabe: Alias
 *  ist freier Anzeigetext, nicht Teil des Ziels). Die schließende `]]`
 *  (bzw. das `|`) direkt nach dem exakt escapten Ziel verhindert einen
 *  Teilmatch auf ein LÄNGERES Ziel mit demselben Präfix (z. B. `a/b` matcht
 *  NICHT `[[a/bc]]`). */
function replaceWikiLinkTarget(raw: string, oldRawTarget: string, newRawTarget: string): string {
  const pattern = new RegExp(`\\[\\[${escapeRegExp(oldRawTarget)}(\\|[^\\]]*)?\\]\\]`, 'g')
  return raw.replace(pattern, (_m, aliasGroup: string | undefined) => `[[${newRawTarget}${aliasGroup ?? ''}]]`)
}

/** Schreibt einen neuen Frontmatter-`title` in `content` — derselbe
 *  Schreibpfad wie das Titelfeld im Editor (`editor-root.tsx`:
 *  `setFrontmatterMetadata(frontmatterRawRef.current, { title: value })`)
 *  bzw. `drafts/release-metadata.ts`: `splitFrontmatter` trennt den Block ab,
 *  `setFrontmatterMetadata` setzt/ersetzt NUR `title` (alle anderen Felder,
 *  insbesondere die stabile `id`, bleiben unverändert erhalten, da sie nicht
 *  in `metadataValues` adressiert werden), `joinFrontmatter` fügt Block+Body
 *  wieder zusammen. Der Body bleibt dabei komplett unangetastet. */
function withUpdatedTitle(content: string, title: string): string {
  const { frontmatterRaw, body } = splitFrontmatter(content)
  const newFrontmatterRaw = setFrontmatterMetadata(frontmatterRaw, { title })
  return joinFrontmatter(newFrontmatterRaw, body)
}

/**
 * Normalisiert ein relatives Linkziel (bereits Anker-befreit) zu einem
 * Repo-Wurzel-relativen Pfad — dieselbe Join/Normalize-Regel wie
 * `LinkResolver#resolveRelative` (`indexer/resolve-links.ts:85-97`), hier
 * dupliziert: wir lösen NICHT über den DB-gestützten `LinkResolver` auf
 * (keine Titel-/Id-Kenntnis nötig), sondern brauchen nur die reine
 * Pfad-Arithmetik, um zu prüfen, ob ein Linkziel auf eine BEWEGTE Seite zeigt.
 * `null`, wenn der Pfad die Repo-Wurzel verlässt (zu viele `../`).
 */
function normalizeRelativeTarget(sourceDir: string, rawTarget: string): string | null {
  const joined = nodePath.posix.normalize(nodePath.posix.join(sourceDir, rawTarget))
  if (joined.startsWith('..')) return null
  return joined.replace(/^\.?\//, '').replace(/^\.$/, '')
}

/** Prüft, ob ein normalisiertes Linkziel (Ergebnis von {@link normalizeRelativeTarget})
 *  auf den ALTEN Pfad einer bewegten Seite zeigt — direkt (literaler Dateipfad,
 *  z. B. mit `.md`-Suffix) ODER als Verzeichnisform (`<dir>/index.md`), exakt
 *  dieselben zwei Versuche wie `LinkResolver#resolveRelative`. */
function matchMovedPage(normalized: string, movedPages: readonly MovedPage[]): MovedPage | undefined {
  const direct = movedPages.find((p) => p.oldPath === normalized)
  if (direct) return direct
  const asDir = normalized === '' ? 'index.md' : `${normalized.replace(/\/+$/, '')}/index.md`
  return movedPages.find((p) => p.oldPath === asDir)
}

/** Berechnet einen relativen Linkpfad von `fromDir` zu `toPath` (POSIX) — im
 *  selben "Stil" wie das ORIGINAL-Linkziel: endete es auf `.md` (literaler
 *  Dateipfad), bleibt der `/index.md`-Suffix erhalten; sonst wird er entfernt
 *  (Verzeichnisform, wie `wikiTargetForPath` es für Wikilinks tut) — ein
 *  Ergebnis von `''` (Ziel = eigenes Verzeichnis) wird zu `'.'` (löst über
 *  `LinkResolver#resolveRelative`s Verzeichnisform-Fallback zurück auf
 *  `<fromDir>/index.md` auf). */
function relativeLinkTarget(fromDir: string, toPath: string, keepMdSuffix: boolean): string {
  const rel = nodePath.posix.relative(fromDir, toPath)
  if (keepMdSuffix) return rel
  const stripped = rel.replace(/(^|\/)index\.md$/, '')
  return stripped.length === 0 ? '.' : stripped
}

/** Schreibt JEDES Vorkommen von `](oldRawTarget)` (optional mit Markdown-Link-
 *  Titel, `](oldRawTarget "Titel")`) im Roh-Markdown auf `](newRawTarget)` um.
 *  Die unmittelbar folgende schließende `)` (bzw. der Titel-String davor)
 *  direkt nach dem exakt escapten Ziel verhindert — analog
 *  {@link replaceWikiLinkTarget} — einen Teilmatch auf ein LÄNGERES Ziel mit
 *  demselben Präfix (z. B. `a/b` matcht NICHT `](a/bc)`). Der sichtbare
 *  Link-TEXT (`[...]`) bleibt unverändert — nur das Ziel in `(...)` wird
 *  ersetzt, unabhängig vom Text davor. */
function replaceRelativeLinkTarget(raw: string, oldRawTarget: string, newRawTarget: string): string {
  const pattern = new RegExp(`\\]\\(\\s*${escapeRegExp(oldRawTarget)}(\\s+"[^"]*")?\\s*\\)`, 'g')
  return raw.replace(pattern, (_m, titleGroup: string | undefined) => `](${newRawTarget}${titleGroup ?? ''})`)
}

interface MovedPage {
  oldPath: string
  newPath: string
  id: string
  title: string
  content: string
}

/** Liest eine `.order`-Datei tolerant (Muster `drafts/reorder-children.ts#
 *  tryReadOrderFile`, hier dupliziert statt importiert — dasselbe „kleine,
 *  IO-nahe Helfer dupliziert statt über Modulgrenzen geteilt"-Muster wie
 *  `directoryOf` in `indexer/order-file.ts`): `null` bei `NotFoundError`,
 *  sonst Inhalt + Blob-`sha` (für ein Update-`writeFile`/`deleteFile` mit
 *  Konfliktprüfung). */
async function tryReadOrderFile(
  provider: GitProvider,
  repo: RepoRef,
  filePath: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    return await provider.readFile(repo, filePath, 'main')
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/** Entfernt `id` aus der `.order`-Datei von `parentDir` (falls vorhanden) —
 *  schreibt die verbleibende Liste zurück, oder LÖSCHT die Datei, wenn sie
 *  danach leer wäre (dieselbe „leer ⇒ löschen"-Regel wie
 *  `reorder-children.ts#reorderChildren`). Idempotent: fehlt die Datei ODER
 *  steht die id gar nicht (mehr) drin, passiert nichts (wiederaufgenommener
 *  Move nach Teilfehler). */
async function removeFromParentOrderFile(
  provider: GitProvider,
  repo: RepoRef,
  parentDir: string,
  id: string,
): Promise<FileChange | null> {
  const filePath = orderFilePath(parentDir)
  const existing = await tryReadOrderFile(provider, repo, filePath)
  if (!existing) return null
  const ids = parseOrderFile(existing.content)
  if (!ids.includes(id)) return null
  const next = ids.filter((entryId) => entryId !== id)
  const content = serializeOrderFile(next)
  // Eine leere Reihenfolge ist keine Reihenfolge: Die Datei verschwindet,
  // statt als leere Hülle stehenzubleiben.
  return content.length === 0
    ? { op: 'delete', path: filePath, sha: existing.sha }
    : { op: 'write', path: filePath, content: Buffer.from(content, 'utf8'), sha: existing.sha }
}

/** Hängt `id` ans Ende der `.order`-Datei von `parentDir` an — NUR wenn diese
 *  Datei bereits existiert (ohne vorherige explizite Reihenfolge sortiert die
 *  verschobene Seite einfach alphabetisch mit den übrigen Kindern ein, s.
 *  Modul-Kommentar `indexer/order-file.ts`; es wird bewusst KEINE neue
 *  `.order`-Datei allein für diese eine Seite angelegt). Idempotent: steht die
 *  id bereits drin (wiederaufgenommener Move), wird nichts geschrieben. */
async function appendToParentOrderFileIfExists(
  provider: GitProvider,
  repo: RepoRef,
  parentDir: string,
  id: string,
): Promise<FileChange | null> {
  const filePath = orderFilePath(parentDir)
  const existing = await tryReadOrderFile(provider, repo, filePath)
  if (!existing) return null
  const ids = parseOrderFile(existing.content)
  if (ids.includes(id)) return null
  return {
    op: 'write',
    path: filePath,
    content: Buffer.from(serializeOrderFile([...ids, id]), 'utf8'),
    sha: existing.sha,
  }
}

/** Lädt den frischesten Lock-Zeitstempel und meldet, ob er noch innerhalb der
 *  TTL frisch ist (dieselbe TTL-Logik wie `loadFreshLock`, `drafts/
 *  lifecycle.ts`, hier ohne `mine`-Berechnung — für die Blockade-Prüfung
 *  zählt nur „hält IRGENDJEMAND aktuell einen Lock", nicht wer). */
async function hasFreshLock(db: Db, pageId: string, now: () => number): Promise<boolean> {
  const rows = await db.select().from(locks).where(eq(locks.pageId, pageId)).limit(1)
  const row = rows[0]
  if (!row) return false
  return now() - row.heartbeatAt.getTime() < LOCK_TTL_MS
}

export async function movePage(
  deps: MovePageDeps,
  provider: GitProvider,
  repo: RepoRef,
  space: SpaceConfig,
  pageId: string,
  pagePath: string,
  pageTitle: string,
  input: MovePageInput,
): Promise<MovePageResult> {
  const now = deps.now ?? Date.now
  const sourceDir = directoryOf(pagePath)

  // Echter No-Op: weder Titel noch Ziel-Parent angegeben — nichts zu tun,
  // ohne dass die Slug-Fallback-Logik unten (die für die Wurzelseite ohne
  // Titel einen NEUEN Slug ableiten würde) fälschlich einen Move auslöst.
  if (input.title === undefined && input.parentId === undefined) {
    return { id: pageId, space: space.id, path: pagePath, movedCount: 0 }
  }

  // --- 0. Space-Root-Schutz: die Wurzelseite selbst darf nicht verschoben/umbenannt
  //     werden (sie ist der Einstieg des gesamten Space) — VOR jedem Schreibvorgang,
  //     noch vor Zielpfad-Ableitung/Kollisionsprüfung. ---
  if (sourceDir === '') {
    throw new RootPageMoveError('Die Startseite des Space kann nicht verschoben oder umbenannt werden.')
  }

  // --- 1. Zielverzeichnis ableiten (Titel-Validierung, Parent-Auflösung, Zyklus-Check) ---
  let targetParentDir: string
  if (input.parentId === undefined) {
    // Reines Umbenennen — Elternverzeichnis bleibt UNVERÄNDERT (das ist das
    // aktuelle Elternverzeichnis DER SEITE, nicht ihr eigenes Verzeichnis!).
    targetParentDir = parentDirOf(sourceDir)
  } else if (input.parentId === null) {
    targetParentDir = ''
  } else {
    const parent = await findByRefFallback(deps.db, space.id, 'id', input.parentId)
    if (!parent) {
      throw new ParentPageNotFoundError(`Übergeordnete Seite "${input.parentId}" ist nicht bekannt.`)
    }
    if (isUnderSourceDir(parent.path, sourceDir)) {
      throw new CircularMoveError(
        `Die Zielseite liegt innerhalb des zu verschiebenden Verzeichnisses ("${sourceDir || '(Space-Wurzel)'}") — `
          + 'ein Verschieben dorthin wäre ein Zyklus (die Seite würde ihr eigener Vorfahre).',
      )
    }
    targetParentDir = directoryOf(parent.path)
  }

  // `renamedTitle` (Ergänzung Rename→Frontmatter): der neue, NORMALISIERTE Titel,
  // NUR gesetzt, wenn `title` im Move-Input übergeben wurde — unten (Schritt 3)
  // wird damit AUSSCHLIESSLICH der Frontmatter-`title` der PRIMÄRSEITE (deren
  // `id === pageId`) überschrieben, mitverschobene Unterseiten bleiben unberührt.
  let newSlug: string
  let renamedTitle: string | undefined
  if (input.title !== undefined) {
    const normalized = normalizeTitle(input.title)
    const slug = pathSegmentFromTitle(normalized)
    if (slug === null) {
      throw new InvalidTitleError(
        `Titel "${input.title}" ergibt keinen gültigen Seitennamen — bitte einen Titel mit mindestens einem `
          + 'Buchstaben oder einer Ziffer wählen (nicht ausschließlich Satzzeichen/Bindestriche).',
      )
    }
    newSlug = slug
    renamedTitle = normalized
  } else {
    // Reines Verschieben (kein `title`): Pfad-Slug bleibt exakt der aktuelle
    // (Root-Fall entfällt — die Wurzelseite wurde bereits oben, Schritt 0, abgelehnt).
    newSlug = sourceDir.split('/').pop()!
  }

  const targetDir = targetParentDir === '' ? newSlug : `${targetParentDir}/${newSlug}`

  // --- 2. No-Op-Kurzschluss: Zielverzeichnis == Quellverzeichnis → nichts zu tun ---
  if (targetDir === sourceDir) {
    return { id: pageId, space: space.id, path: pagePath, movedCount: 0 }
  }

  // --- 3. Betroffene Seiten sammeln (rekursiv, via listTree gegen main) ---
  const tree = await provider.listTree(repo, 'main')
  const sourcePaths = tree
    .filter((e) => isPageFile(e.path, e.type))
    .map((e) => e.path)
    .filter((p) => isUnderSourceDir(p, sourceDir))

  if (!sourcePaths.includes(pagePath)) {
    // Die zu verschiebende Seite selbst ist auf main nicht vorhanden — z. B.
    // eine Draft-only-Seite, die nie released wurde. Es gibt nichts zu
    // verschieben (kein Commit-Ziel); derselbe 404-Vertrag wie bei GET/PUT/
    // DELETE des Drafts (`resolveWriteContext`-Aufrufer).
    throw new NotFoundError(
      `Seite "${pagePath}" ist auf main nicht vorhanden (nur als Entwurf angelegt) — Verschieben ist erst nach `
        + 'einem Release möglich.',
    )
  }

  const movedPages: MovedPage[] = []
  for (const oldPath of sourcePaths) {
    const file = await provider.readFile(repo, oldPath, 'main')
    const parsed = parsePage(file.content)
    const id = derivePageId(space.id, oldPath, parsed.frontmatter.id)
    let title = parsed.title ?? deriveTitle(oldPath, space.name)
    let content = file.content
    if (renamedTitle !== undefined && id === pageId) {
      // NUR die primäre (direkt umbenannte) Seite bekommt den neuen
      // Frontmatter-`title` — mitverschobene Unterseiten (andere `id`) behalten
      // ihren eigenen Titel unverändert (Design-Vorgabe: Rename ist NICHT rekursiv).
      content = withUpdatedTitle(content, renamedTitle)
      title = renamedTitle
    }
    const newPath = rewritePath(oldPath, sourceDir, targetDir)
    movedPages.push({ oldPath, newPath, id, title, content })
  }

  // --- 4. Draft/Review-Blockade: JEDE betroffene Seite, VOR jedem Schreiben ---
  const blocked: string[] = []
  for (const p of movedPages) {
    const branch = draftBranchName(p.id)
    const [hasDraft, hasLock] = await Promise.all([
      branchExists(provider, repo, branch),
      hasFreshLock(deps.db, p.id, now),
    ])
    if (hasDraft || hasLock) blocked.push(p.id)
  }
  if (blocked.length > 0) {
    throw new MoveBlockedError(
      `${blocked.length === 1 ? 'Eine Seite hat' : `${blocked.length} Seiten haben`} einen offenen Entwurf oder `
        + 'aktiven Lock — erst Review abschließen oder Entwurf verwerfen, bevor verschoben werden kann.',
      blocked,
    )
  }

  // --- 5. Kollisionsprüfung (main + draft) gegen main+draft für JEDEN neuen Pfad ---
  for (const p of movedPages) {
    const collision = await findByRefFallback(deps.db, space.id, 'path', p.newPath)
    if (collision) {
      throw new PageCollisionError(`Unter "${p.newPath}" existiert bereits eine Seite oder ein Entwurf.`, collision.id)
    }
  }

  // --- 6./7./7b. Kopieren: Seiten, `_media` und `.order` in EINEM Commit ---
  //
  // Warum gesammelt und nicht je Datei: Gemessen am 2026-07-28 brauchte der
  // Move von „Virtuelle Maschinen" (Unterseiten mit je zwei Dutzend
  // Bildschirmabzügen) über den Einzelweg 400 Commits und 177 Sekunden — der
  // Browser gab lange vorher auf und meldete dem Nutzer einen Fehlschlag,
  // während der Server unbeirrt weiterarbeitete. Als Sammel-Commit sind es
  // drei Commits: kopieren, Links nachziehen, aufräumen.
  //
  // Der Baumabzug von oben trägt Pfade UND Blob-SHAs. Beides wird hier
  // gebraucht und spart je Datei einen Abruf: „existiert das Ziel schon?"
  // (Wiederaufnahme nach Teilfehler) und später der SHA fürs Löschen. Der
  // Abzug ist frisch — er entstand in Schritt 3 dieses Laufs.
  const movedIds = new Set(movedPages.map((p) => p.id))
  const fileShaByPath = new Map(tree.filter((e) => e.type === 'file').map((e) => [e.path, e.sha]))
  const existsInTree = (path: string) => fileShaByPath.has(path)

  const copyChanges: FileChange[] = []
  for (const p of movedPages) {
    if (existsInTree(p.newPath)) continue
    copyChanges.push({ op: 'write', path: p.newPath, content: Buffer.from(p.content, 'utf8') })
  }

  const mediaToDelete: string[] = []
  for (const p of movedPages) {
    const oldMediaDir = mediaDirFor(p.oldPath)
    const newMediaDir = mediaDirFor(p.newPath)
    const mediaPrefix = `${oldMediaDir}/`
    const mediaFiles = tree.filter((e) => e.type === 'file' && e.path.startsWith(mediaPrefix))
    for (const mediaFile of mediaFiles) {
      mediaToDelete.push(mediaFile.path)
      const newMediaPath = `${newMediaDir}/${mediaFile.path.slice(mediaPrefix.length)}`
      if (existsInTree(newMediaPath)) continue
      // Der Inhalt muss gelesen werden — ihn kennt nur das Repository. Das
      // sind Abrufe, keine Commits: Sie kosten Millisekunden, kein Schreiben.
      const media = await provider.readFileBinary(repo, mediaFile.path, 'main')
      copyChanges.push({ op: 'write', path: newMediaPath, content: media.content })
    }
  }

  // --- 7b. `.order`-Dateien INNERHALB des verschobenen Verzeichnisses mitkopieren
  //     (rekursiver Move: die Reihenfolge der Unterseiten übersteht den Move) —
  //     `orderFilesToMove` schließt `orderFilePath(sourceDir)` selbst ein (ordnet
  //     die Kinder DER bewegten Primärseite) UND jede verschachtelte `.order`-Datei
  //     tiefer im Baum (ordnet Kinder mitverschobener Unterseiten). Dieselbe
  //     Präfix-Ersetzung wie bei Seiten/Medien (`rewritePath`), Kopieren VOR dem
  //     Löschen (Schritt 9), idempotent (Ziel existiert bereits → überspringen). ---
  const orderFilesToMove = tree
    .filter((e) => e.type === 'file' && e.path.startsWith(`${sourceDir}/`) && e.path.endsWith(`/${ORDER_FILENAME}`))
    .map((e) => e.path)
  for (const oldOrderPath of orderFilesToMove) {
    const newOrderPath = rewritePath(oldOrderPath, sourceDir, targetDir)
    if (existsInTree(newOrderPath)) continue
    const orderFile = await provider.readFile(repo, oldOrderPath, 'main')
    copyChanges.push({ op: 'write', path: newOrderPath, content: Buffer.from(orderFile.content, 'utf8') })
  }

  await provider.commitFiles(repo, copyChanges, {
    branch: 'main',
    message: `docs: „${sourceDir}" nach „${targetDir}" verschieben (${copyChanges.length} Dateien)`,
  })

  // --- 8. Wikilink-Rewrite: Referenzierer je bewegter Seite via edges ---
  const referencerRows = await deps.db
    .select({ id: pages.id, path: pages.path, title: pages.title })
    .from(edges)
    .innerJoin(pages, and(eq(pages.id, edges.fromPageId), eq(pages.ref, edges.ref)))
    .where(and(eq(pages.ref, 'main'), inArray(edges.toPageId, [...movedIds]), eq(edges.type, 'link')))

  const referencerById = new Map<string, { path: string }>()
  for (const row of referencerRows) referencerById.set(row.id, { path: row.path })
  // Nachschärfung: JEDE bewegte Seite selbst muss durchlaufen werden — nicht nur,
  // wenn sie (laut `edges`) eine ANDERE bewegte Seite referenziert (dafür wäre sie
  // bereits über `referencerRows` erfasst), sondern IMMER, weil ihr EIGENES
  // Verzeichnis sich verschoben hat und damit JEDER ihrer relativen Links neu
  // berechnet werden muss (unten, relative-Link-Zweig) — unabhängig davon, ob
  // dessen Ziel selbst mitbewegt wurde oder unverändert liegen blieb.
  for (const p of movedPages) {
    if (!referencerById.has(p.id)) referencerById.set(p.id, { path: p.oldPath })
  }

  const referencerChangedPaths: string[] = []
  const rewriteChanges: FileChange[] = []
  for (const [referencerId, { path: mainPath }] of referencerById) {
    const movedSelf = movedPages.find((p) => p.id === referencerId)
    let writePath: string
    let raw: string
    let sha: string
    if (movedSelf) {
      // Design-Vorgabe: „Ein Referenzierer, der selbst bewegt wird, wird an
      // seinem NEUEN Pfad rewritten" — der alte Pfad wird gleich gelöscht.
      writePath = movedSelf.newPath
      const fresh = await provider.readFile(repo, writePath, 'main')
      raw = fresh.content
      sha = fresh.sha
    } else {
      writePath = mainPath
      const fresh = await provider.readFile(repo, writePath, 'main')
      raw = fresh.content
      sha = fresh.sha
    }

    const parsedLinks = parsePage(raw).links

    const replacements = new Map<string, string>()
    for (const link of parsedLinks) {
      if (link.kind !== 'wikilink') continue
      if (replacements.has(link.rawTarget)) continue
      const target = movedPages.find((p) => isPathFormTarget(link.rawTarget, p.oldPath))
      if (!target) continue
      const { anchor } = splitAnchor(link.rawTarget)
      replacements.set(link.rawTarget, `${wikiTargetForPath(target.newPath, target.title)}${anchor}`)
    }

    // Relative Markdown-Links (`](...)`): `basisOldDir`/`basisNewDir` sind das
    // Verzeichnis, aus dessen Sicht die relativen Ziele im Roh-Markdown zu
    // interpretieren sind — bei einem NICHT bewegten Referenzierer bleiben beide
    // gleich `directoryOf(mainPath)` (nur Ziele, die selbst bewegt wurden,
    // brauchen ein Rewrite); bei einer bewegten Seite selbst unterscheiden sie
    // sich (ihr eigenes Verzeichnis hat sich verschoben) — JEDER ihrer relativen
    // Links muss deshalb neu berechnet werden, auch auf ein unverändertes Ziel.
    const basisOldDir = movedSelf ? directoryOf(movedSelf.oldPath) : directoryOf(mainPath)
    const basisNewDir = movedSelf ? directoryOf(movedSelf.newPath) : directoryOf(mainPath)
    const relativeReplacements = new Map<string, string>()
    for (const link of parsedLinks) {
      if (link.kind !== 'relative') continue
      if (relativeReplacements.has(link.rawTarget)) continue
      const { base, anchor } = splitAnchor(link.rawTarget)
      const trimmedBase = base.trim()
      if (trimmedBase.length === 0) continue
      // Eigene `_media`-Anhänge wandern 1:1 mit der Seite mit (ihr relativer Pfad
      // bleibt unverändert gültig) — nicht als Seiten-Ziel interpretieren.
      if (isMediaLink(trimmedBase)) continue
      const normalizedOld = normalizeRelativeTarget(basisOldDir, trimmedBase)
      if (normalizedOld === null) continue // verlässt die Repo-Wurzel — unangetastet lassen
      const movedTarget = matchMovedPage(normalizedOld, movedPages)
      if (!movedTarget && !movedSelf) continue // Ziel nicht bewegt UND Quelle nicht bewegt → weiterhin gültig
      const resolvedNewAbs = movedTarget ? movedTarget.newPath : normalizedOld
      const keepMdSuffix = /\.md$/i.test(trimmedBase)
      const newRel = relativeLinkTarget(basisNewDir, resolvedNewAbs, keepMdSuffix)
      const newRawTarget = `${newRel}${anchor}`
      if (newRawTarget === link.rawTarget) continue
      relativeReplacements.set(link.rawTarget, newRawTarget)
    }

    if (replacements.size === 0 && relativeReplacements.size === 0) continue

    let updated = raw
    for (const [oldRawTarget, newRawTarget] of replacements) {
      updated = replaceWikiLinkTarget(updated, oldRawTarget, newRawTarget)
    }
    for (const [oldRawTarget, newRawTarget] of relativeReplacements) {
      updated = replaceRelativeLinkTarget(updated, oldRawTarget, newRawTarget)
    }
    if (updated === raw) continue

    rewriteChanges.push({ op: 'write', path: writePath, content: Buffer.from(updated, 'utf8'), sha })
    referencerChangedPaths.push(writePath)
  }

  await provider.commitFiles(repo, rewriteChanges, {
    branch: 'main',
    message: `docs: Links nach dem Verschieben von „${sourceDir}" aktualisiert (${rewriteChanges.length} Seiten)`,
  })

  // --- 8b. Eltern-`.order`-Dateien pflegen (nur bei ECHTEM Elternwechsel — reines
  //     Rename lässt die `.order` unangetastet, die stabile id bleibt dort gültig):
  //     id der PRIMÄRSEITE aus der `.order` des alten Elternordners entfernen, ans
  //     Ende der `.order` des neuen Elternordners anhängen (falls diese existiert). ---
  // --- 8b./9. Aufräumen: alte Dateien löschen und die Eltern-`.order` pflegen,
  //     wieder in EINEM Commit. Der Blob-SHA jeder zu löschenden Datei steht im
  //     Baumabzug von Schritt 3 — die alten Pfade hat bis hierher niemand
  //     angefasst (kopiert wurde nur DANEBEN), ihre SHAs gelten also
  //     unverändert. Was der Abzug nicht kennt, ist schon weg: Ein
  //     wiederaufgenommener Move nach Teilfehler überspringt es stillschweigend,
  //     wie zuvor `deleteFileTolerant`. ---
  const cleanupChanges: FileChange[] = []
  const pushDelete = (path: string) => {
    const sha = fileShaByPath.get(path)
    if (sha) cleanupChanges.push({ op: 'delete', path, sha })
  }
  for (const mediaPath of mediaToDelete) pushDelete(mediaPath)
  for (const p of movedPages) pushDelete(p.oldPath)
  for (const oldOrderPath of orderFilesToMove) pushDelete(oldOrderPath)

  const oldParentDir = parentDirOf(sourceDir)
  if (oldParentDir !== targetParentDir) {
    const removed = await removeFromParentOrderFile(provider, repo, oldParentDir, pageId)
    if (removed) cleanupChanges.push(removed)
    const appended = await appendToParentOrderFileIfExists(provider, repo, targetParentDir, pageId)
    if (appended) cleanupChanges.push(appended)
  }

  await provider.commitFiles(repo, cleanupChanges, {
    branch: 'main',
    message: `docs: „${sourceDir}" nach dem Verschieben aufgeräumt (${cleanupChanges.length} Dateien)`,
  })

  // --- 10. Reindex (ein Lauf: entfernte + neue + geänderte Referenzierer) ---
  await indexChangedFiles(
    { db: deps.db, provider },
    space,
    [...movedPages.map((p) => p.newPath), ...referencerChangedPaths],
    movedPages.map((p) => p.oldPath),
  )

  const primary = movedPages.find((p) => p.id === pageId)
  return {
    id: pageId,
    space: space.id,
    path: primary?.newPath ?? rewritePath(pagePath, sourceDir, targetDir),
    movedCount: movedPages.length,
  }
}
