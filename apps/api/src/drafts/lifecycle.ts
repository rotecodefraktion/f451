import { and, eq } from 'drizzle-orm'
import type { GitFile, GitProvider, RepoRef } from '@f451/git-provider'
import { ConflictError, NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { locks, pages } from '../db/schema.js'
import { draftBranchName } from './branch-name.js'

/**
 * Draft-Lifecycle (Plan Task 2): Anlegen (idempotent), Lesen und Verwerfen
 * eines Draft-Branches. Der Draft-ZUSTAND wird bewusst nie separat
 * gespeichert (Spec Abschnitt 4/9): `working` ⇔ der Branch `draft/<pageId>`
 * existiert. Alle Operationen arbeiten mit dem GitProvider des ANFRAGENDEN
 * Nutzers (Nutzer-Token, siehe `drafts/user-provider.ts` — echte
 * Autorschaft), der von den Routen (Task 2, `routes/drafts.ts`) bereits
 * aufgelöst und übergeben wird.
 */

/** Ein 2 min gültiger Soft-Lock (Spec Abschnitt 4) — Hinweis-Charakter, blockiert nichts.
 *  Das volle Heartbeat-/Übernahme-Verhalten kommt erst mit Task 4 (`routes/locks.ts`);
 *  hier wird nur der aktuell gespeicherte Lock gemeldet, sofern er noch frisch ist.
 *  `mine` (Task 1, P1-Fix): serverseitig gegen die anfragende userId berechnet —
 *  der Client bekommt nie eine fremde userId, nur diese vorberechnete Auskunft. */
export interface DraftLock {
  user: string
  heartbeatAt: string
  mine: boolean
}

/** Antwortform für POST/GET /api/pages/:id/draft (Plan Task 2 Interface). */
export interface DraftInfo {
  branch: string
  baseSha: string
  content: string
  lock: DraftLock | null
}

/** Locks gelten laut Spec 2 min — dieselbe TTL wird von Task 4 (Heartbeat/Übernahme)
 *  wiederverwendet; hier bereits nötig, um einen abgelaufenen Lock nicht fälschlich
 *  als aktiv in der Draft-Antwort zu melden (Hinweis-Charakter, aber kein STILLER
 *  veralteter Hinweis). */
export const LOCK_TTL_MS = 2 * 60 * 1000

export interface DraftLifecycleDeps {
  db: Db
  /** Injectbare Uhr (Default: Date.now) — für deterministische Lock-TTL-Tests. */
  now?: () => number
}

/** Lädt den aktuellen Lock einer Seite, sofern er noch innerhalb der TTL frisch ist
 *  (abgelaufene Locks gelten als "kein Lock" — Übernahme ist Task 4s Aufgabe, hier
 *  wird nur nicht fälschlich ein toter Lock gemeldet). `requestingUserId` (Task 1,
 *  P1-Fix): die anfragende userId, gegen die `mine` serverseitig berechnet wird —
 *  NIE die fremde userId selbst an den Client weiterreichen. Exportiert seit
 *  Phase 2d Task 2: `routes/pages.ts` braucht dieselbe (billige, DB-only) Lock-
 *  Auskunft für das `workflow.lock`-Feld der Lese-API. */
export async function loadFreshLock(
  deps: DraftLifecycleDeps,
  pageId: string,
  requestingUserId: string,
): Promise<DraftLock | null> {
  const rows = await deps.db.select().from(locks).where(eq(locks.pageId, pageId)).limit(1)
  const row = rows[0]
  if (!row) return null

  const now = deps.now ?? Date.now
  if (now() - row.heartbeatAt.getTime() >= LOCK_TTL_MS) return null

  return { user: row.userName, heartbeatAt: row.heartbeatAt.toISOString(), mine: row.userId === requestingUserId }
}

/** true, wenn der Branch existiert (`getHeadSha` erfolgreich), false bei NotFoundError.
 *  Exportiert seit Fix-Runde 1 (Phase 2d Task 2 Review): `routes/webhooks.ts` braucht
 *  denselben toleranten Existenz-Check für den Branch-only-Fallback, wenn die
 *  Rückwärts-Suche (`findPageIdForDraftBranch`) keine passende pageId findet. */
export async function branchExists(provider: GitProvider, repo: RepoRef, branch: string): Promise<boolean> {
  try {
    await provider.getHeadSha(repo, branch)
    return true
  } catch (err) {
    if (err instanceof NotFoundError) return false
    throw err
  }
}

/** Zustandsableitung (Plan Task 2 Interface): `working`, wenn der Draft-Branch
 *  existiert, sonst `null` (kein Draft). Phase 2d Task 2 erweitert das additiv
 *  um `review` (offener PR) — siehe `getWorkflowState` unten; `getDraftState`
 *  bleibt unverändert bestehen (keine Aufrufer im Produktionscode mehr, aber
 *  weiter exportiert/getestet, kein Grund zum Entfernen). */
export type DraftState = 'working' | null

export async function getDraftState(provider: GitProvider, repo: RepoRef, pageId: string): Promise<DraftState> {
  const branch = draftBranchName(pageId)
  return (await branchExists(provider, repo, branch)) ? 'working' : null
}

/** Minimale PR-Auskunft für die Workflow-Antwort (UI-Bedarf: Nummer + Link
 *  zum nativen PR, siehe Plan Task 2 Interface) — bewusst kein vollständiges
 *  `PullRequestInfo` durchgereicht (das trüge u. a. `mergeable`, das hier
 *  nicht gebraucht wird und dessen Beschaffung einen zweiten Request wert wäre). */
export interface WorkflowPrInfo {
  number: number
  url: string
}

export interface WorkflowStateInfo {
  state: 'working' | 'review'
  pr: WorkflowPrInfo | null
}

/** `null` = kein Draft-Branch (kein Entwurf). Sonst `working` (Branch existiert,
 *  kein offener PR) oder `review` (offener PR mit Head `draft/<pageId>`, Base
 *  `main` — `pr` trägt dessen Nummer/Link fürs UI). Ersetzt/erweitert
 *  `getDraftState` additiv (Plan Task 2 Interface, Spec §4). */
export type WorkflowState = WorkflowStateInfo | null

/**
 * Leitet den Workflow-Zustand einer Seite ab (Phase 2d Task 2, Spec §4):
 * `working` ⇔ Draft-Branch existiert und kein offener PR; `review` ⇔
 * zusätzlich ein offener PR mit Head `draft/<pageId>` gegen `main` existiert
 * (erster Treffer aus `listPullRequests` zählt — pro Draft-Branch ist
 * höchstens ein offener PR sinnvoll, mehrere wären ein Bedienfehler außerhalb
 * dieser Plattform). Zustand bleibt bewusst ABGELEITET, nie in der DB
 * gepflegt (Spec §4/9) — derselbe Grundsatz wie bei `getDraftState`.
 */
export async function getWorkflowState(provider: GitProvider, repo: RepoRef, pageId: string): Promise<WorkflowState> {
  const branch = draftBranchName(pageId)
  if (!(await branchExists(provider, repo, branch))) return null

  const openPrs = await provider.listPullRequests(repo, { head: branch, base: 'main', state: 'open' })
  const first = openPrs[0]
  if (first) {
    return { state: 'review', pr: { number: first.number, url: first.url } }
  }
  return { state: 'working', pr: null }
}

/**
 * Legt den Draft-Branch vom aktuellen `main`-HEAD an, falls er noch nicht
 * existiert — IDEMPOTENT: existiert er bereits, wird nur der aktuelle Stand
 * zurückgegeben (Plan Task 2: „existiert → 200 mit Bestand"). Ein Race
 * zwischen der Existenzprüfung und `createBranch` (zwei parallele Requests
 * legen gleichzeitig an) wird über den `ConflictError` des Providers
 * abgefangen — der zweite Aufrufer verliert das Rennen, verwendet aber
 * anschließend denselben, jetzt existierenden Branch. `requestingUserId`
 * (Task 1): fließt ausschließlich in `loadFreshLock`s `mine`-Berechnung ein.
 */
export async function createOrGetDraft(
  deps: DraftLifecycleDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
  pagePath: string,
  requestingUserId: string,
): Promise<DraftInfo> {
  const branch = draftBranchName(pageId)

  if (!(await branchExists(provider, repo, branch))) {
    try {
      await provider.createBranch(repo, branch, 'main')
    } catch (err) {
      // Bereits von einer parallelen Anfrage angelegt (Race) — Idempotenz-
      // Vertrag verlangt trotzdem ein erfolgreiches Ergebnis mit dem
      // (nun existierenden) Bestand, kein Fehler.
      if (!(err instanceof ConflictError)) throw err
    }
  }

  const file = await provider.readFile(repo, pagePath, branch)
  const lock = await loadFreshLock(deps, pageId, requestingUserId)
  return { branch, baseSha: file.sha, content: file.content, lock }
}

/**
 * Liefert den aktuellen Draft-Stand, oder `null`, wenn (noch) kein Draft-
 * Branch existiert (Aufrufer mappt das auf 404, Plan Task 2). Prüft NICHT
 * separat auf Branch-Existenz, sondern behandelt den NotFoundError von
 * `readFile` direkt als "kein Draft" — ein fehlender Branch und eine
 * fehlende Datei im (existierenden) Branch sind aus Nutzersicht ununter-
 * scheidbar ("kein lesbarer Entwurf"). `requestingUserId` (Task 1): wie bei
 * `createOrGetDraft`, fließt nur in `loadFreshLock`s `mine`-Berechnung ein.
 */
export async function getDraft(
  deps: DraftLifecycleDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
  pagePath: string,
  requestingUserId: string,
): Promise<DraftInfo | null> {
  const branch = draftBranchName(pageId)

  let file: GitFile
  try {
    file = await provider.readFile(repo, pagePath, branch)
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }

  const lock = await loadFreshLock(deps, pageId, requestingUserId)
  return { branch, baseSha: file.sha, content: file.content, lock }
}

/** Entfernt die Draft-Index-Zeilen (`ref='draft'`) einer Seite — eigene, exportierte
 *  Funktion (statt inline in `discardDraft`), damit sie isoliert testbar ist, auch
 *  bevor Task 3 (Draft-Indexierung) überhaupt Zeilen mit `ref='draft'` erzeugt. */
export async function clearDraftIndex(db: Db, pageId: string): Promise<void> {
  await db.delete(pages).where(and(eq(pages.id, pageId), eq(pages.ref, 'draft')))
}

/** Löst den Lock einer Seite, unabhängig davon, wer ihn hält (das Verwerfen des
 *  gesamten Drafts räumt auch einen fremden/veralteten Lock mit auf). */
async function clearLock(db: Db, pageId: string): Promise<void> {
  await db.delete(locks).where(eq(locks.pageId, pageId))
}

/**
 * Verwirft einen Draft vollständig (Plan Task 2): löscht den Branch, die
 * Draft-Index-Zeilen (`ref='draft'`) und einen eventuell gehaltenen Lock.
 * Wirft `NotFoundError`, wenn der Branch nicht existiert — der Aufrufer
 * mappt das auf 404 (dieselbe "kein Draft"-Semantik wie bei `getDraft`).
 *
 * Prüft die Existenz VORAB explizit (statt sich auf den Fehler von
 * `provider.deleteBranch` zu verlassen): Forgejo antwortet beim Löschen
 * eines nicht existierenden Branches nicht mit 404, sondern mit einem
 * generischen 500 (`toProviderError` mappt das auf `ProviderError`, nicht
 * `NotFoundError`) — ein Vertrag, den `GitProvider` an dieser Stelle nicht
 * einheitlich abbildet.
 *
 * Reihenfolge bewusst DB-Aufräumen (`clearDraftIndex`/`clearLock`) VOR
 * `deleteBranch` (Final-Review-Befund 2): Bricht der Prozess NACH dem
 * Branch-Löschen ab, blieben Index-/Lock-Zeilen sonst verwaist — und ein
 * erneuter DELETE würde mit 404 (Branch bereits weg) enden, räumt also nie
 * auf. In dieser Reihenfolge repariert ein Retry nach einem gescheiterten
 * `deleteBranch` beides: DB ist schon sauber, nur der Branch fehlt noch.
 * Der Fehler von `deleteBranch` propagiert unverändert an den Aufrufer
 * (kein stiller Verlust — der Client muss wissen, dass der Branch noch
 * existiert).
 */
export async function discardDraft(
  deps: DraftLifecycleDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
): Promise<void> {
  const branch = draftBranchName(pageId)
  if (!(await branchExists(provider, repo, branch))) {
    throw new NotFoundError(`Draft-Branch "${branch}" existiert nicht.`)
  }
  await clearDraftIndex(deps.db, pageId)
  await clearLock(deps.db, pageId)
  await provider.deleteBranch(repo, branch)
}

/**
 * Nach-Merge-Cleanup (Phase 2d Task 2, Spec §4 „Nach Merge: […] Draft-Branch
 * löschen"): löscht Draft-Index-Zeilen, Lock und den Draft-Branch, nachdem ein
 * Review-PR gemerged wurde. Zwei Aufrufer teilen sich diese Funktion: der
 * `pull_request`-Webhook (nativer Merge im Forgejo-/GitHub-UI, `routes/webhooks.ts`)
 * und — ab Task 3 — die synchrone Release-Route (Primärpfad). Reihenfolge wie
 * `discardDraft` (Final-Review-Befund 2): DB VOR Branch, damit ein
 * abgebrochener Prozess nie verwaiste DB-Zeilen hinterlässt.
 *
 * Anders als `discardDraft` TOLERIERT diese Funktion einen bereits fehlenden
 * Branch — bei einem nativen Merge mit aktiviertem „Branch löschen"-Häkchen
 * hat der Provider ihn selbst schon entfernt, das ist hier kein Fehlerfall,
 * sondern der Normalfall. Prüft die Existenz VORAB explizit (`branchExists`,
 * genau wie `discardDraft`) statt sich auf `NotFoundError` von `deleteBranch`
 * zu verlassen: Forgejo antwortet beim Löschen eines nicht existierenden
 * Branches NICHT mit 404, sondern einem generischen 500 (`ProviderError`,
 * siehe `discardDraft`-Kommentar oben) — ein `catch (NotFoundError)` würde
 * diesen Normalfall fälschlich als Fehler weiterwerfen.
 *
 * Nimmt (wie jede andere Funktion in diesem Modul, z. B. `discardDraft`)
 * bereits aufgelöste `provider`/`repo`-Parameter entgegen — beide Aufrufer
 * (Webhook, Release-Route) haben das Repo längst über `providerRegistry(space)`
 * bzw. `resolveWriteContext` aufgelöst; eine spaceId→Provider-Auflösung
 * innerhalb dieser reinen Business-Logik-Schicht würde die bestehende
 * Schichtung durchbrechen (lifecycle.ts kennt weder Space-Konfiguration noch
 * Provider-Registry).
 */
export async function cleanupMergedDraft(
  deps: DraftLifecycleDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
): Promise<void> {
  const branch = draftBranchName(pageId)
  await clearDraftIndex(deps.db, pageId)
  await clearLock(deps.db, pageId)
  if (await branchExists(provider, repo, branch)) {
    await provider.deleteBranch(repo, branch)
  }
}

/**
 * Findet die pageId zu einem Draft-Branch-Namen per RÜCKWÄRTS-SUCHE über die
 * offenen Drafts eines Space (Phase 2d Task 2 Fix-Runde 1, Important-Review-
 * Befund). Hintergrund: `draftBranchName` hängt bei pageIds mit git-unsicheren
 * Zeichen (`:`, `/`, Leerraum, …) einen IRREVERSIBLEN Hash-Suffix an — und das
 * ist der NORMALFALL, nicht die Ausnahme: die Fallback-Id des Indexers für
 * Seiten OHNE Frontmatter-`id` ist `path:<spaceId>/<filePath>`
 * (`indexer/index-space.ts`) und enthält daher immer `:` und `/`. Ein simples
 * Strippen des `draft/`-Präfixes vom Branch-Namen (die vorherige, seit der
 * ersten Umsetzung von `routes/webhooks.ts#pageIdFromDraftBranch` bestehende
 * Implementierung) liefert für diesen häufigsten Fall NICHT die echte pageId
 * zurück, sondern den sanitisierten Slug inklusive Hash-Suffix — Folge:
 * `clearDraftIndex`/`clearLock` trafen die falsche id, die echte
 * Draft-Index-/Lock-Zeile blieb nach einem nativen Merge verwaist.
 *
 * Die Kandidatenmenge ist klein (offene Drafts des betroffenen Space): Zeilen
 * aus `pages` mit `ref='draft'` sowie über `locks` (gejoint auf die
 * `ref='main'`-Zeile derselben Id, um auf den Space einzuschränken — `locks`
 * selbst trägt keine `spaceId`-Spalte) dieses Space. Für jede Kandidaten-Id
 * wird `draftBranchName` erneut berechnet — deterministisch, reversiert damit
 * auch hash-suffigierte Branches korrekt — und mit `headBranch` verglichen:
 * O(offene Drafts), kein Schema-Change. Kein Treffer (z. B. ein Retry, nachdem
 * der Cleanup bereits durchgelaufen ist, oder ein Branch, der nie über diesen
 * Workflow entstand) → `null`; der Aufrufer (`routes/webhooks.ts`) fällt dann
 * auf reines Branch-Cleanup ohne DB-Aufräumen zurück.
 */
export async function findPageIdForDraftBranch(
  deps: DraftLifecycleDeps,
  spaceId: string,
  headBranch: string,
): Promise<string | null> {
  const draftRows = await deps.db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.ref, 'draft'), eq(pages.spaceId, spaceId)))
  const lockRows = await deps.db
    .select({ id: locks.pageId })
    .from(locks)
    .innerJoin(pages, and(eq(pages.id, locks.pageId), eq(pages.ref, 'main')))
    .where(eq(pages.spaceId, spaceId))

  const candidates = new Set<string>()
  for (const row of draftRows) candidates.add(row.id)
  for (const row of lockRows) candidates.add(row.id)

  for (const candidate of candidates) {
    if (draftBranchName(candidate) === headBranch) return candidate
  }
  return null
}
