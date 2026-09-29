import { and, eq, inArray } from 'drizzle-orm'
import { slugify, stringifyFrontmatterBlock } from '@f451/markdown'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { ConflictError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { pages } from '../db/schema.js'
import type { SpaceConfig } from '../spaces/config.js'
import { generatePageId } from '../indexer/page-id.js'
import { branchExists } from './lifecycle.js'
import { draftBranchName } from './branch-name.js'
import { gitBlobSha1 } from './blob-sha.js'
import { indexDraftPage } from './save.js'
import { renderTemplate, templateDatum } from '../templates/render.js'

/**
 * Neue Seite anlegen (Phase 2d Task 5, Spec „Neue Seite" im Schreibpfad):
 * legt eine noch nie released Seite als DRAFT-ONLY an — es entsteht bewusst
 * KEIN Commit auf `main` (das passiert erst über den normalen Review-/
 * Release-Workflow, Task 3/4). Die Seite ist danach sofort über den Editor-
 * Pfad erreichbar (`resolveWriteContext`s Draft-only-Fallback, `routes/drafts.ts`)
 * und im Draft-Index such-/baumbar (`indexDraftPage`, wie jeder Autosave).
 */

/** Kollision: unter dem berechneten Zielpfad existiert bereits eine Seite —
 *  entweder auf `main` (bereits released) ODER als Draft-only-Seite eines
 *  anderen Autors (noch nie released, aber der Pfad ist "reserviert"). Trägt
 *  die `pageId` der bestehenden Seite, damit der Aufrufer (Route) sie in der
 *  409-Antwort verlinken kann (Plan Task 5 Interface: „mit Link-Möglichkeit"). */
export class PageCollisionError extends Error {
  constructor(
    message: string,
    public readonly pageId: string,
  ) {
    super(message)
    this.name = 'PageCollisionError'
  }
}

/** Die per `parentId` referenzierte Seite ist weder auf `main` noch als
 *  Draft-only-Seite bekannt — es gibt kein Verzeichnis, unter dem die neue
 *  Seite angelegt werden könnte. */
export class ParentPageNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParentPageNotFoundError'
  }
}

/** `pathSegmentFromTitle(title)` liefert `null` — entweder weil `slugify(title)`
 *  einen leeren String ergibt (z. B. ein Titel, der ausschließlich aus
 *  Satzzeichen/Symbolen besteht: ein leerer Slug würde einen malformten Pfad
 *  erzeugen, `/index.md` an der Wurzel bzw. `<Verzeichnis>//index.md` unter
 *  einem `parentId`) ODER weil nach dem Strippen führender/abschließender
 *  Bindestriche (Fix-Runde 2, git-Pfadsicherheit) nichts mehr übrig bleibt
 *  (Titel bestand ausschließlich aus Bindestriche/Leerzeichen). Fastifys
 *  `minLength: 1`-Schema prüft nur die rohe Zeicheneingabe, nicht das
 *  Slug-Ergebnis — dieser Fehler deckt die Lücke ab. */
export class InvalidTitleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTitleError'
  }
}

/** Baut aus einem (bereits normalisierten) Titel ein GIT-PFADSICHERES Segment für
 *  den Zielpfad (`<segment>/index.md`): `slugify` (siehe
 *  `packages/markdown/src/slug.ts`) behält Bindestriche 1:1 — das ist bewusst so
 *  (GitHub-Anker-Verhalten, geteilt mit `parsePage`/`renderHtml`) und wird HIER
 *  NICHT geändert. Ein Titel, der mit `"- "` beginnt, ergibt dadurch einen Slug
 *  mit FÜHRENDEM Bindestrich (z. B. `"- Strich zuerst"` → `"--strich-zuerst"`) —
 *  Forgejo lehnt ein Pfadsegment mit führendem `-` als alleinstehendes ERSTES
 *  Segment mit „git command is broken" ab (das zugrunde liegende `git`-Kommando
 *  interpretiert es ohne `--`-Trenner als Option, HTTP 500). Deshalb NUR für die
 *  Pfadbildung: führende/abschließende Bindestriche nach dem Slugifying strippen.
 *  Liefert `null`, wenn danach nichts mehr übrig bleibt (Titel bestand
 *  ausschließlich aus Satzzeichen/Symbolen ODER ausschließlich aus
 *  Bindestrichen/Leerzeichen) — der Aufrufer wandelt das in eine
 *  `InvalidTitleError` (→ 400). */
export function pathSegmentFromTitle(title: string): string | null {
  const segment = slugify(title).replace(/^-+|-+$/g, '')
  return segment.length === 0 ? null : segment
}

export interface CreatePageDeps {
  db: Db
}

/** Antwortform (Plan Task 5 Interface): identisch zu `DraftInfo` + `id`/`space`/
 *  `path` — der Editor kann die Antwort von `POST /api/pages` genauso öffnen
 *  wie die von `POST /api/pages/:id/draft`. */
export interface CreatePageResult {
  id: string
  space: string
  path: string
  branch: string
  baseSha: string
  content: string
}

/** Exportiert seit Phase 3.2 (`drafts/move-page.ts`): dieselbe Datei-/Suffix-
 *  Konvention wird beim Verschieben/Umbenennen für die Zielpfad-Bildung gebraucht. */
export const INDEX_MD = 'index.md'
export const INDEX_MD_SUFFIX = `/${INDEX_MD}`

/** Normalisiert Zeilenumbrüche im Titel zu je einem Leerzeichen (Fix Review-Befund 1,
 *  Phase 2d Task 5): Das Route-Schema (`routes/create-page.ts#createPageBodySchema`)
 *  beschränkt `title` nur mit `minLength: 1`, erlaubt technisch also auch Newlines.
 *  Der Initialinhalt schreibt den Titel aber sowohl ins Frontmatter als auch als
 *  `# `-Heading — ein Heading ist per Markdown-Definition einzeilig, ein Newline darin
 *  würde den Rest des Titels in einen eigenen Absatz-Block reißen. Bewusst
 *  normalisieren statt mit 400 ablehnen (konsistent zum Schema, das den Fall nicht
 *  ausschließt): `POST /api/pages` liefert für JEDEN vom Schema akzeptierten Titel
 *  garantiert 201 mit parsePage-fehlerfreiem Initialinhalt. */
export function normalizeTitle(title: string): string {
  return title.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** Verzeichnis einer Seiten-Datei aus ihrem Pfad (immer `index.md` oder
 *  `<Verzeichnis>/index.md`, siehe `indexer/index-space.ts#isPageFile`):
 *  leerer String für die Wurzelseite, sonst der Pfad ohne das `/index.md`-Suffix.
 *  Exportiert seit Phase 3.2 (`drafts/move-page.ts`): Verschieben/Umbenennen
 *  braucht dieselbe Ableitung wie die Seitenanlage (Quell-/Ziel-Verzeichnis). */
export function directoryOf(pagePath: string): string {
  return pagePath === INDEX_MD ? '' : pagePath.slice(0, -INDEX_MD_SUFFIX.length)
}

/** Findet eine Seite über beide Refs (main bevorzugt, sonst draft-only) —
 *  dieselbe Fallback-Idee wie `resolveWriteContext`s Draft-only-Erweiterung,
 *  hier gebraucht, um sowohl das Eltern-Verzeichnis (`parentId`) als auch eine
 *  Pfad-Kollision gegen main UND draft-only-Seiten zu prüfen. Exportiert seit
 *  Phase 3.2 (`drafts/move-page.ts`): dieselbe Ziel-Parent-/Kollisionsprüfung
 *  wird beim Verschieben/Umbenennen wiederverwendet, statt sie zu duplizieren. */
export async function findByRefFallback(
  db: Db,
  spaceId: string,
  where: 'id' | 'path',
  value: string,
): Promise<{ id: string; path: string } | undefined> {
  const column = where === 'id' ? pages.id : pages.path
  const rows = await db
    .select({ id: pages.id, path: pages.path, ref: pages.ref })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), eq(column, value), inArray(pages.ref, ['main', 'draft'])))
  const main = rows.find((r) => r.ref === 'main')
  return main ?? rows[0]
}

/**
 * Legt eine neue Seite als Draft-only-Seite an (Plan Task 5 Ablauf):
 * 1. Zielpfad ableiten (`parentId` → dessen Verzeichnis, sonst Space-Wurzel;
 *    `<Verzeichnis>/<pathSegmentFromTitle(title)>/index.md` — git-pfadsicheres
 *    Segment, siehe Doku dort).
 * 2. Kollision prüfen (main ODER draft-only am selben Pfad → `PageCollisionError`).
 * 3. Seiten-Id GENERIEREN (Phase 3.1, `generatePageId`, `indexer/page-id.ts`) —
 *    NEU seit Phase 3.1: vormals leitete `derivePageId(spaceId, path, undefined)`
 *    mangels Frontmatter-`id` eine PFADBASIERTE Fallback-Id ab; jetzt bekommt
 *    JEDE neu angelegte Seite von Anfang an eine stabile, zufällige Id, die
 *    direkt ins Frontmatter geschrieben wird (`stringifyFrontmatterBlock`
 *    unten). Identitätsstabilität über den Release-Zyklus bleibt trotzdem
 *    gewahrt — nicht mehr WEIL Pfad und Id zusammenfallen, sondern weil sowohl
 *    die Draft-Indexierung (`indexDraftPage`, `drafts/save.ts`) als auch der
 *    main-Indexer (`buildPageInfo`/`derivePageId`, `indexer/index-space.ts`)
 *    die Id aus GENAU demselben `id:`-Frontmatter-Feld lesen, das hier einmalig
 *    geschrieben wird — beide Indexierungen kommen also weiterhin zwangsläufig
 *    auf dieselbe Id, ohne dass ihre Formel dupliziert wäre.
 * 4. Draft-Branch `draft/<pageId>` von `main` ableiten (idempotent, wie
 *    `createOrGetDraft` — ein `ConflictError` bei einer parallelen Anlage wird
 *    toleriert, der bereits existierende Branch wird weiterverwendet).
 * 5. `index.md` OHNE `sha` schreiben (= Anlage, kein Überschreiben).
 * 6. Draft-Indexierung (`indexDraftPage`), damit die Seite sofort such-/baumbar ist.
 *
 * `template` (Phase 3c Task 3, optional): der (bereits per `readTemplateBody`
 * gelesene) Template-Body ersetzt den Auto-`# <Titel>`-Anhang — das
 * Standard-Frontmatter (`title:`) bleibt in JEDEM Fall unverändert, es gibt
 * KEINE zusätzliche Vorlagen-Metadaten (z. B. `description:`) im Initialinhalt.
 * Ohne `template` ist das Verhalten byte-identisch zum Bestand.
 */
export async function createPage(
  deps: CreatePageDeps,
  provider: GitProvider,
  repo: RepoRef,
  space: SpaceConfig,
  parentId: string | undefined,
  title: string,
  template?: { body: string; autor: string },
): Promise<CreatePageResult> {
  let parentDir = ''
  if (parentId !== undefined) {
    const parent = await findByRefFallback(deps.db, space.id, 'id', parentId)
    if (!parent) {
      throw new ParentPageNotFoundError(`Übergeordnete Seite "${parentId}" ist nicht bekannt.`)
    }
    parentDir = directoryOf(parent.path)
  }

  const normalizedTitle = normalizeTitle(title)
  const slug = pathSegmentFromTitle(normalizedTitle)
  if (slug === null) {
    throw new InvalidTitleError(
      `Titel "${title}" ergibt keinen gültigen Seitennamen — bitte einen Titel mit mindestens einem `
        + 'Buchstaben oder einer Ziffer wählen (nicht ausschließlich Satzzeichen/Bindestriche).',
    )
  }
  const path = parentDir ? `${parentDir}/${slug}${INDEX_MD_SUFFIX}` : `${slug}${INDEX_MD_SUFFIX}`

  const collision = await findByRefFallback(deps.db, space.id, 'path', path)
  if (collision) {
    throw new PageCollisionError(`Unter "${path}" existiert bereits eine Seite oder ein Entwurf.`, collision.id)
  }

  const id = generatePageId()
  const pageId = id
  const branch = draftBranchName(pageId)

  let branchCreatedHere = false
  if (!(await branchExists(provider, repo, branch))) {
    try {
      await provider.createBranch(repo, branch, 'main')
      branchCreatedHere = true
    } catch (err) {
      // Bereits von einer parallelen Anfrage angelegt (Race) — derselbe
      // Toleranz-Grundsatz wie `createOrGetDraft` (`drafts/lifecycle.ts`).
      if (!(err instanceof ConflictError)) throw err
    }
  }

  // YAML-sicher gebaut (Fix Review-Befund 1): `stringifyFrontmatterBlock` quotet/escaped
  // Titel mit `:`, führendem `-`/`@`/`*`, Quotes usw. korrekt — eine naive
  // String-Interpolation (`title: ${normalizedTitle}`) würde für solche Titel eine
  // YAMLException beim erneuten Parsen auslösen (siehe `frontmatterErrors`/
  // `errorStatus: 'parse_error'` in `indexer/index-space.ts`).
  //
  // `id` (Phase 3.1): die oben generierte stabile Id wird von Anfang an ins
  // Frontmatter geschrieben — `parseFrontmatterBlock` kennt `id` bereits als
  // bekanntes Top-Level-Feld (`frontmatter.ts#KNOWN_FRONTMATTER_KEYS`), landet
  // also korrekt in `parsed.frontmatter.id`, nicht in `metadata`.
  const frontmatterBlock = stringifyFrontmatterBlock({ id, title: normalizedTitle })
  let body: string
  if (template) {
    const rendered = renderTemplate(template.body, {
      titel: normalizedTitle,
      autor: template.autor,
      datum: templateDatum(),
    })
    // Content-Vertrag (siehe `CreatePageResult`/`drafts/save.ts`): Inhalt endet
    // auf `\n`. `readTemplateBody` liefert normalerweise bereits einen mit `\n`
    // endenden Body (Git-Datei + `splitFrontmatter`), hier trotzdem defensiv
    // sichergestellt statt vorausgesetzt.
    body = rendered.endsWith('\n') ? rendered : `${rendered}\n`
  } else {
    body = `# ${normalizedTitle}\n`
  }
  const content = `---\n${frontmatterBlock}\n---\n\n${body}`
  try {
    await provider.writeFile(repo, path, content, { branch, message: `docs: „${normalizedTitle}" anlegen` })
    await indexDraftPage(deps.db, space, pageId, path, content)
  } catch (err) {
    // A branch without the page file is an orphan nobody can reach or discard
    // from the UI (no index row). Remove it again if this request created it;
    // the original error stays the answer.
    if (branchCreatedHere) await provider.deleteBranch(repo, branch).catch(() => undefined)
    throw err
  }

  return { id: pageId, space: space.id, path, branch, baseSha: gitBlobSha1(content), content }
}
