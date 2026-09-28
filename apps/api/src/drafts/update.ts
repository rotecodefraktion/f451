import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import type { SpaceConfig } from '../spaces/config.js'
import { createOrGetDraft, discardDraft, getWorkflowState } from './lifecycle.js'
import { draftBranchName } from './branch-name.js'
import { mediaDirFor } from './upload.js'
import { saveDraft } from './save.js'

/**
 * Content-Verlust-Fenster nach `discardDraft` (Finding 3, Fix-Runde 1): der
 * alte Draft-Branch ist zu diesem Zeitpunkt bereits gelöscht — schlägt einer
 * der beiden folgenden Schritte (`createOrGetDraft`/`saveDraft`) fehl, gäbe
 * es ohne diesen Fehlertyp keinen Weg zurück zum Inhalt, den der Nutzer
 * gerade bearbeitet hat (der Aufrufer würde nur ein generisches 502 sehen).
 * Trägt deshalb `preservedContent` (der VOR dem Verwerfen gelesene Inhalt)
 * mit — die Route (`routes/workflow.ts`) reicht ihn 1:1 in der 502-Antwort
 * weiter, der Client kann ihn erneut speichern, sobald der (frisch
 * angelegte) Draft wieder existiert. Siehe README „Content-Verlust-Fenster".
 */
export class DraftUpdateContentLostError extends Error {
  constructor(
    message: string,
    public readonly preservedContent: string,
  ) {
    super(message)
    this.name = 'DraftUpdateContentLostError'
  }
}

/**
 * Auflösung des Randfalls „Draft↔main auseinandergelaufen" (Plan Task 3, Spec
 * §4): `take-main` verwirft die eigenen Änderungen (Draft wird == main),
 * `keep-mine` verwirft nur den Branch, committet den bewahrten Inhalt aber
 * sofort wieder auf den frisch von main abgeleiteten Draft.
 */
export type UpdateStrategy = 'take-main' | 'keep-mine'

export interface UpdateDraftDeps {
  db: Db
}

export interface UpdateDraftResult {
  baseSha: string
  content: string
  /** true, wenn vor dem Verwerfen ein offener Review-PR existierte — der
   *  Aufrufer (Route) reicht das an dieselbe idempotente PR-Anlage-Logik wie
   *  `POST /api/pages/:id/review` weiter, um den (durch die Branch-Löschung
   *  implizit geschlossenen) PR neu zu eröffnen. */
  hadOpenPr: boolean
  /** Nummer des vor dem Verwerfen offenen PRs (nur gesetzt, wenn
   *  `hadOpenPr`). Die Route braucht sie, um das Race mit Forgejos
   *  ASYNCHRONER PR-Schließung nach der Branch-Löschung aufzulösen (Phase 2d
   *  Task 7, Dev-Smoke real beobachtet): `listPullRequests` listet den alten
   *  PR unmittelbar nach `discardDraft` noch als offen — ohne die Nummer
   *  würde die idempotente Anlage-Logik ihn als „bereits offen"
   *  zurückliefern statt einen neuen zu eröffnen, und kurz darauf schließt
   *  Forgejo ihn → gar kein offener PR mehr, Review-Zustand tot. */
  previousPrNumber?: number
  /** Gesetzt, wenn der verworfene Draft-Branch Media-Dateien enthielt, die auf
   *  main nicht existieren — die gehen beim Verwerfen unwiderruflich verloren
   *  (Upload-Binärdateien werden vom Save-Pfad NICHT mitgenommen, nur der
   *  Markdown-Text). Kein stiller Verlust: die UI zeigt diese Warnung an. */
  warning?: string
}

/**
 * Verwirft den bestehenden Draft-Branch und legt ihn frisch von `main` an
 * (Plan Task 3): `discardDraft` löscht Branch, Draft-Index und Lock — ein
 * eventuell offener Review-PR wird dabei IMPLIZIT vom Provider geschlossen
 * (Forgejo/GitHub schließen einen PR automatisch, sobald sein Head-Branch
 * gelöscht wird; kein zusätzlicher API-Aufruf nötig). Der Bearbeiter kann
 * danach ohne Sonder-Handling weiterarbeiten — der Editor heartbeatet den
 * Lock ohnehin erneut, sobald er den neuen Bestand lädt.
 *
 * `keep-mine` committet den VOR dem Verwerfen gelesenen Inhalt über denselben
 * Save-Pfad wie Autosave (`saveDraft`, deterministischer Blob-SHA, Draft-
 * Index-Aktualisierung) auf den frischen Draft. `take-main` lässt den
 * frischen (== main) Stand unverändert.
 *
 * Wirft `NotFoundError`, wenn (noch) kein Draft-Branch existiert — derselbe
 * Vertrag wie die übrigen Draft-Operationen (Aufrufer mappt auf 404).
 */
export async function updateDraft(
  deps: UpdateDraftDeps,
  provider: GitProvider,
  repo: RepoRef,
  space: SpaceConfig,
  pageId: string,
  pagePath: string,
  title: string,
  requestingUserId: string,
  strategy: UpdateStrategy,
): Promise<UpdateDraftResult> {
  const branch = draftBranchName(pageId)

  // Zustand VOR dem Verwerfen erfassen: existiert überhaupt ein Draft (sonst
  // NotFoundError, wie GET/PUT/DELETE), und war ein Review-PR offen (der
  // Aufrufer braucht das, um ihn ggf. neu zu eröffnen).
  const stateBefore = await getWorkflowState(provider, repo, pageId)
  if (stateBefore === null) {
    throw new NotFoundError(`Kein Entwurf für Seite "${pageId}" vorhanden.`)
  }
  const hadOpenPr = stateBefore.state === 'review'
  const previousPrNumber = stateBefore.pr?.number

  const currentFile = await provider.readFile(repo, pagePath, branch)
  const preservedContent = currentFile.content

  // Media-Verlust-Check (Spec „kein stiller Verlust"): Dateien unter
  // `<Seitenordner>/_media/` auf dem Draft-Branch, die auf main NICHT
  // existieren, verschwinden beim Verwerfen des Branches unwiderruflich —
  // `keep-mine` bewahrt nur den Markdown-TEXT (über `saveDraft`), nicht die
  // Binärdateien selbst. Betrifft beide Strategien gleichermaßen (auch
  // `take-main` wirft den kompletten Branch inkl. Medien weg).
  const mediaPrefix = `${mediaDirFor(pagePath)}/`
  const [draftTree, mainTree] = await Promise.all([
    provider.listTree(repo, branch),
    provider.listTree(repo, 'main'),
  ])
  const draftMediaPaths = draftTree
    .filter((entry) => entry.type === 'file' && entry.path.startsWith(mediaPrefix))
    .map((entry) => entry.path)
  const mainMediaPaths = new Set(
    mainTree.filter((entry) => entry.type === 'file' && entry.path.startsWith(mediaPrefix)).map((entry) => entry.path),
  )
  const lostMedia = draftMediaPaths.filter((path) => !mainMediaPaths.has(path))
  const warning = lostMedia.length > 0
    ? `Media-Dateien gehen beim Aktualisieren verloren (nicht auf main vorhanden): ${lostMedia.join(', ')}`
    : undefined

  // Verwerfen (Branch + Draft-Index + Lock) und frisch von main neu anlegen.
  // AB HIER ist der alte Branch weg — jeder Fehler in den folgenden beiden
  // Schritten MUSS `preservedContent` tragen (Finding 3, Fix-Runde 1), sonst
  // verliert der Nutzer seine Arbeit still (generisches 502 ohne Inhalt).
  await discardDraft(deps, provider, repo, pageId)

  let fresh: Awaited<ReturnType<typeof createOrGetDraft>>
  try {
    fresh = await createOrGetDraft(deps, provider, repo, pageId, pagePath, requestingUserId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DraftUpdateContentLostError(
      `Entwurf verworfen, Neuanlage fehlgeschlagen: ${message}`,
      preservedContent,
    )
  }

  if (strategy === 'take-main') {
    return { baseSha: fresh.baseSha, content: fresh.content, hadOpenPr, previousPrNumber, warning }
  }

  // keep-mine: bewahrten Inhalt über denselben Save-Pfad wie Autosave
  // committen (SHA-Vertrag erfüllt automatisch, `fresh.baseSha` ist der
  // gerade erst von main abgeleitete, garantiert aktuelle Stand).
  try {
    const saved = await saveDraft(deps, provider, repo, space, pageId, pagePath, title, preservedContent, fresh.baseSha)
    return { baseSha: saved.newSha, content: preservedContent, hadOpenPr, previousPrNumber, warning }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DraftUpdateContentLostError(
      `Entwurf verworfen und neu angelegt, aber "keep-mine"-Speichern fehlgeschlagen: ${message}`,
      preservedContent,
    )
  }
}
