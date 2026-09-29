/**
 * Client-seitiger API-Client für den Editor (Phase 2c). Anders als
 * `lib/api.ts` (Server Components, direkter Aufruf gegen `API_URL`, Cookie
 * als expliziter Parameter) fetchen Client-Inseln RELATIV über die
 * Next-Rewrites (`next.config.ts`: `/api/*`, `/media/*` → API) mit
 * `credentials: 'same-origin'`, damit der Browser den Session-Cookie
 * automatisch mitschickt — Muster: `components/search-dialog.tsx`.
 *
 * Verträge aus `apps/api/README.md` Abschnitt „Draft-API (Schreiben)"
 * (Task 1, Phase 2c-Vorarbeiten):
 * - `POST`/`GET /api/pages/:id/draft` → `{branch, baseSha, content, lock}`
 * - `PUT` Body `{content, baseSha, message?}` → `200 {newSha, savedAt}` |
 *   `409 {error, currentSha, currentContent}` — der 409 ist ein ERWARTETER
 *   Vertragsfall (jemand anders hat zwischenzeitlich gespeichert), KEIN
 *   Ausnahmefall: {@link saveDraft} wirft dafür nicht, sondern liefert ein
 *   diskriminiertes Ergebnis, aus dem der Aufrufer (Task 6) die
 *   Zusammenführungsansicht baut.
 * - `POST …/draft/media` (Multipart-Feld `file`) → `200 {path, markdown}`;
 *   `413`/`415`/`422` tragen die präzise Server-Meldung im `reason`-Feld
 *   (`{status, reason}`, siehe `apps/api/src/routes/drafts.ts#errorSchema`
 *   — NICHT `{error}`, das ist das Format der 403-Antworten).
 * - `PUT`/`DELETE /api/locks/:pageId` → `{heldBy, expiresAt, mine}` /
 *   `204`.
 * - `GET /api/search` → Treffer mit `path` (seit Task 1).
 *
 * Verträge aus `apps/api/README.md` Abschnitt „Workflow-API" (Phase 2d Task
 * 3/4/5) — dieselbe Philosophie wie oben: dokumentierte Nicht-200-Fälle sind
 * ERWARTETE Vertragsfälle (diskriminiertes Ergebnis), nur ein wirklich
 * unerwarteter Status (502/Netzwerk/…) wirft {@link ClientApiError}:
 * - `POST /api/pages/:id/review` `{reviewers?}` → `200 {number, url,
 *   state:'review', mergeable}` | `409 {error}` (kein Draft) | `422 {error,
 *   reason:'no_changes'}` (Draft hat gegenüber main keinen einzigen Commit —
 *   Fix #11: Forgejo ließ einen solchen PR zwar anlegen, der Merge scheiterte
 *   dann dauerhaft mit transientem 405) — s. {@link requestReview}.
 * - `POST /api/pages/:id/release` `{comment?}` → `200 {mergeSha,
 *   approveWarning?}` | `403 {error}` (kein Freigabe-Recht) | `409 {error,
 *   reason?:'conflict'}` | `422 {error, reason:'no_changes'}` (dieselbe
 *   Leer-Prüfung wie bei `POST .../review`, hier für Drafts, deren PR vor
 *   diesem Fix oder unabhängig von der API eröffnet wurde) — s.
 *   {@link releasePage}. NUR client-api-Typen in Phase 2d Task 6 — die UI
 *   (Freigeben-Button) folgt in Task 7.
 * - `POST /api/pages/:id/review/request-changes` `{comment}` → `204` |
 *   `409|422 {error}` — s. {@link requestChanges}. Ebenfalls nur Typen, Task 7.
 * - `POST /api/pages/:id/draft/update` `{strategy}` → `200 {baseSha, content,
 *   state, pr, warning?}` | `502 {status, reason, preservedContent?}` — s.
 *   {@link updateDraft}. `preservedContent` ist NUR bei einem 502 NACH dem
 *   Verwerfen des alten Draft-Branchs gesetzt (Content-Verlust-Fenster,
 *   `apps/api/README.md`) — typisiert zugreifbar statt in einem generischen
 *   Fehlerkörper vergraben, „kein stiller Verlust" gilt auch client-seitig.
 * - `POST /api/pages` `{space, parentId?, title}` → `201 {id, space, path,
 *   branch, baseSha, content}` | `400 {status,reason}` (ungültiger
 *   Titel-Slug) | `403 {error}` | `409 {error, pageId}` (Kollision) — s.
 *   {@link createPage}.
 * - `GET /api/pages/:id/review` → `200 {pr, authorName, diff, page}` | `404`
 *   (kein offenes Review) — s. {@link getReview}. NUR client-api-Typen in
 *   Phase 2d Task 6, die Review-Ansicht selbst ist Task 7; `diff` bleibt
 *   deshalb bewusst `unknown` (kein `MarkdownDiff`-Typ dupliziert, den nur
 *   Task 7 tatsächlich rendert).
 * - `PUT /api/pages/:id/draft/diagram` `{path, content, ifAbsent?}` → `200
 *   {path}` | `409 {status, reason}` (Ziel existiert bereits UND `ifAbsent`
 *   war gesetzt) — s. {@link saveDiagram}. Wie bei {@link saveDraft} ist der
 *   409 ein erwarteter Vertragsfall (diskriminiertes Ergebnis statt Wurf);
 *   alle übrigen Nicht-200-Fälle (400/413/415/422/…) laufen über das
 *   etablierte {@link ClientApiError}-Muster der Datei. {@link loadDiagram}
 *   liest den aktuellen Draft-Stand einer Diagrammdatei über die
 *   Media-Route (`ref=draft`, kein eigener API-Endpunkt nötig).
 * - `PUT /api/spaces/:space/order` `{parentId, orderedIds}` → `200 {parentId,
 *   path, orderedIds}` | `400 {status,reason}` (Fremd-Id/Duplikat) | `403
 *   {error}` | `404 {status,reason}` (Space/`parentId` unbekannt) — s.
 *   {@link reorderChildren} (Phase 3.3, „Baum-Umsortierung über `.order`-
 *   Dateien", `apps/api/src/routes/reorder.ts`).
 */

import type { MarkdownDiff, MetadataSchema } from '@f451/markdown'
import { apiSpaceMetadataSchemaPath, mediaHref } from '../urls.js'
import { t as translate } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import type { T } from '../i18n/types.js'

// Phase 2 (i18n): NUR die beiden client-seitigen Fallback-Fehlertexte, die im
// Editor-Umfang sichtbar sind (`uploadMedia`s `DEFAULT_UPLOAD_ERROR_MESSAGE` →
// `wysiwyg-editor.tsx`; `saveAsTemplate`s 400/403/409-Fallbacks →
// `save-template-dialog.tsx`) bekommen `t` als OPTIONALES Feld — alle anderen
// Funktionen dieser Datei (movePage, releasePage, reorderChildren, …) bedienen
// Bereiche außerhalb dieser Phase (Baum, Review, Vorlagen-Verwaltung) und bleiben
// unverändert deutsch, s. Task-Umfang. `DEFAULT_T` (DE-Fallback) hält
// Bestandstests, die ohne `t` aufrufen, unverändert lauffähig.
const DEFAULT_T: T = (key, params) => translate(de, key, params)

/** Fehler eines API-Aufrufs mit HTTP-Status. `status === 0` = Netzwerk-/Verbindungsfehler.
 *  Wird NICHT für 409 (Save-Konflikt, s. {@link saveDraft}) oder 401 (s. {@link SessionExpiredError})
 *  geworfen — beide sind eigene, erwartete Fälle. */
export class ClientApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ClientApiError'
    this.status = status
    this.body = body
  }
}

/** Geworfen, wenn die Session serverseitig als abgelaufen/ungültig gilt (401).
 *  Bewusst KEINE {@link ClientApiError}-Instanz: der Aufrufer soll diesen Fall
 *  nicht wie einen normalen API-Fehler behandeln (Fehlerkarte, Retry) — die
 *  Umleitung zur Login-Seite ist bereits ausgelöst (s. {@link redirectToLogin}),
 *  der Fehler dient nur noch dazu, die aufrufende Promise-Kette zu stoppen. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Sitzung abgelaufen — Weiterleitung zur Anmeldung.')
    this.name = 'SessionExpiredError'
  }
}

/** Fehler eines Media-Uploads (413/415/422) mit der präzisen Server-Meldung
 *  aus dem `reason`-Feld der Fehlerantwort als `message`. */
export class UploadError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'UploadError'
    this.status = status
  }
}

/** Aktueller Soft-Lock einer Seite, Teil jeder Draft-Antwort. */
export interface DraftLock {
  user: string
  heartbeatAt: string
  mine: boolean
}

/** Antwort-Shape von `POST`/`GET /api/pages/:id/draft`. */
export interface DraftInfo {
  branch: string
  baseSha: string
  content: string
  lock: DraftLock | null
}

/** Body von `PUT /api/pages/:id/draft`. */
export interface SaveDraftBody {
  content: string
  baseSha: string
  message?: string
}

/** Diskriminiertes Ergebnis von {@link saveDraft} — der 409-Konflikt ist ein
 *  erwarteter Vertragsfall, kein Wurf (s. Modul-Kommentar oben). */
export type SaveDraftResult =
  | { ok: true; newSha: string; savedAt: string }
  | { ok: false; conflict: { currentSha: string; currentContent: string } }

/** Antwort-Shape von `POST /api/pages/:id/draft/media` — `kind` unterscheidet
 *  Bild (`setImage`) von Datei-Anhang (Datei-Link, s. `apps/api/src/drafts/upload.ts`
 *  Editor-Erweiterung „Datei-Anhänge"). `markdown` ist nur dokumentativ — der Editor
 *  fügt den Node strukturiert über `path`/`kind` ein, s. wysiwyg-editor.tsx. */
export interface UploadMediaResult {
  path: string
  markdown: string
  kind: 'image' | 'file'
}

/** Antwort-Shape von `PUT /api/locks/:pageId`. */
export interface LockInfo {
  heldBy: string
  expiresAt: string
  mine: boolean
}

/** Ein Treffer aus `GET /api/search` (Feldauswahl, die der Editor braucht —
 *  `rank` ist Teil der Server-Antwort, aber hier ungenutzt, s. YAGNI). */
export interface SearchResult {
  id: string
  title: string
  space: string
  path: string
  snippet: string
}

export interface SearchPagesOptions {
  space?: string
  ref?: 'main' | 'draft'
  /** Präfix-Suche (Phase 3a): das letzte Wort matcht als Wortanfang
   *  (tsquery `:*`) — für Tipp-Suche (⌘K-Dialog, `[[`-Autocomplete). */
  prefix?: boolean
}

/** Baut das `next=<aktueller Pfad>`-Rückkehrziel und leitet zur Login-Seite
 *  weiter — Muster aus `app/wiki/layout.tsx` (`redirect('/?next=' + …)`),
 *  hier als Browser-Navigation, da `next/navigation#redirect` außerhalb von
 *  Server Components/Actions nicht funktioniert. In Nicht-Browser-Umgebungen
 *  (Tests ohne `window`-Stub) ein No-Op. */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return
  const target = `${window.location.pathname}${window.location.search}`
  window.location.href = `/?next=${encodeURIComponent(target)}`
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** Ruft `fetch` relativ mit `credentials: 'same-origin'` auf und wirft
 *  {@link ClientApiError} mit `status: 0` bei einem Netzwerkfehler. Liefert
 *  die rohe {@link Response} zurück — Statusauswertung obliegt den
 *  Aufrufern (unterschiedliche Routen brauchen unterschiedliche
 *  Sonderfälle, z. B. 409 bei `saveDraft`, 413/415/422 bei `uploadMedia`). */
async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, { ...init, credentials: 'same-origin' })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ClientApiError(0, `Netzwerkfehler beim Abruf von ${path}: ${message}`, undefined)
  }
}

/** Gemeinsamer Pfad für die einfachen Fälle (kein 409/413/415/422-Sonderfall):
 *  401 → {@link redirectToLogin} + {@link SessionExpiredError}, jeder andere
 *  Fehlerstatus → {@link ClientApiError}, `204` → `undefined`, sonst der
 *  geparste JSON-Body. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawFetch(path, init)

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** `POST /api/pages/:id/draft` — legt den Draft an (falls nicht vorhanden)
 *  oder liefert den Bestand; idempotent, siehe Routen-Referenz. */
export function createDraft(pageId: string): Promise<DraftInfo> {
  return request<DraftInfo>(`/api/pages/${encodeURIComponent(pageId)}/draft`, { method: 'POST' })
}

export interface SaveDraftOptions {
  /** `true` für den `pagehide`/`beforeunload`-Pfad (Review-Fund 3, Phase 2c
   *  Task 4): die Anfrage darf den Unload-Moment überleben, statt mit dem
   *  verworfenen Dokument abgebrochen zu werden (Muster {@link releaseLock}).
   *  Reicht direkt an `fetch` durch — undefined lässt `keepalive` auf dem
   *  Browser-Default (`false`). */
  keepalive?: boolean
}

/** `PUT /api/pages/:id/draft` — Autosave. Der 409-Konflikt ist KEIN Wurf,
 *  sondern Teil des Rückgabetyps (s. {@link SaveDraftResult}). */
export async function saveDraft(
  pageId: string,
  body: SaveDraftBody,
  opts?: SaveDraftOptions,
): Promise<SaveDraftResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/draft`
  const res = await rawFetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: opts?.keepalive,
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409) {
    const conflict = (await readJsonBody(res)) as { currentSha?: string; currentContent?: string } | undefined
    // Das Server-Schema garantiert beide Felder — fehlt eines (defekter Proxy,
    // abgeschnittener Body), wäre ein Konflikt-Dialog ohne Vergleichsstand
    // sinnlos: als transienter Fehler behandeln (Retry-Pfad) statt zu crashen.
    if (typeof conflict?.currentSha !== 'string' || typeof conflict.currentContent !== 'string') {
      throw new ClientApiError(res.status, `409 ohne vollständigen Konflikt-Body für ${path}`, conflict)
    }
    return { ok: false, conflict: { currentSha: conflict.currentSha, currentContent: conflict.currentContent } }
  }

  if (!res.ok) {
    const errBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, errBody)
  }

  const data = (await res.json()) as { newSha: string; savedAt: string }
  return { ok: true, newSha: data.newSha, savedAt: data.savedAt }
}

/** `DELETE /api/pages/:id/draft` — verwirft den Draft vollständig (204). */
export async function discardDraft(pageId: string): Promise<void> {
  await request<void>(`/api/pages/${encodeURIComponent(pageId)}/draft`, { method: 'DELETE' })
}

/** `DELETE /api/pages/:id` (Feature „Seite löschen") — löscht die Seite
 *  vollständig (main-Commit, Index, ein evtl. offener Draft), `200 {ok:true}`.
 *  Fehler laufen über das etablierte {@link ClientApiError}-Muster der Datei
 *  (403 ohne Schreibrecht, 502 bei Provider-Fehler) — kein diskriminiertes
 *  Ergebnis nötig, die Aufrufstelle (`status-bar.tsx`) fragt bereits per
 *  Bestätigungsdialog nach, ein Fehlschlag zeigt schlicht eine Fehlermeldung
 *  (Muster {@link discardDraft}s Aufrufer in `editor-root.tsx`). */
export async function deletePage(pageId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/pages/${encodeURIComponent(pageId)}`, { method: 'DELETE' })
}

/** Erfolgs-Shape von `POST /api/pages/:id/move` (Phase 3.2). `id` bleibt
 *  UNVERÄNDERT gegenüber dem Aufruf (stabile Id, Phase 3.1) — nur `path`
 *  ändert sich. `movedCount` zählt die (samt Unterseiten) tatsächlich
 *  verschobenen Seiten (0 bei einem No-Op-Aufruf ohne Änderung). */
export interface MovePageInfo {
  id: string
  space: string
  path: string
  movedCount: number
}

/** Body von `POST /api/pages/:id/move`: `title` (Rename, Zielpfad-Segment aus
 *  dem Titel abgeleitet) und `parentId` (Move-Ziel — `null` = Space-Wurzel,
 *  `undefined`/fehlend = Elternverzeichnis unverändert) sind unabhängig
 *  voneinander optional und dürfen zusammen angegeben werden. */
export interface MovePageBody {
  title?: string
  parentId?: string | null
}

/** Diskriminiertes Ergebnis von {@link movePage} — 400 (ungültiger Titel-Slug
 *  ODER Ziel-Parent liegt im eigenen Unterbaum), 403 (kein Schreibrecht), 404
 *  (Seite/Ziel-Parent unbekannt) und 409 (Pfad-Kollision MIT `pageId` der
 *  bestehenden Seite, ODER Draft/Lock-Blockade MIT `blockedPageIds`) sind
 *  dokumentierte Vertragsfälle, kein Wurf — der Umbenennen-/Verschieben-Dialog
 *  zeigt daraus eine spezifische Meldung statt einer generischen Fehlerkarte. */
export type MovePageResult =
  | { ok: true; page: MovePageInfo }
  | { ok: false; status: 400 | 403 | 404; error: string }
  | { ok: false; status: 409; error: string; pageId?: string; blockedPageIds?: string[] }

/** `POST /api/pages/:id/move` (Phase 3.2, „Seite verschieben/umbenennen") —
 *  s. `apps/api/src/routes/move-page.ts`. */
export async function movePage(pageId: string, body: MovePageBody): Promise<MovePageResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/move`
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409) {
    const parsed = (await readJsonBody(res)) as
      | { error?: string; pageId?: string; status?: string; reason?: string; blockedPageIds?: string[] }
      | undefined
    const error = parsed?.error ?? parsed?.reason ?? 'Zielpfad ist bereits belegt oder blockiert.'
    return { ok: false, status: 409, error, pageId: parsed?.pageId, blockedPageIds: parsed?.blockedPageIds }
  }

  if (res.status === 400 || res.status === 404) {
    const body2 = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: res.status, error: body2?.reason ?? 'Verschieben/Umbenennen nicht möglich.' }
  }

  if (res.status === 403) {
    // Fix-Runde 1 (Review 4a-3, Finding 2): auch CSRF-Hook-403s ({status,reason})
    // korrekt anzeigen — s. Kommentar in {@link releasePage}.
    const body2 = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return { ok: false, status: 403, error: body2?.error ?? body2?.reason ?? 'Kein Schreibrecht für diesen Space.' }
  }

  if (!res.ok) {
    const errBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, errBody)
  }

  const data = (await res.json()) as MovePageInfo
  return { ok: true, page: data }
}

/** Erfolgs-Shape von `POST /api/pages/:id/unarchive` (Feature „Unarchive"). */
export interface UnarchivePageInfo {
  id: string
  path: string
}

/** Diskriminiertes Ergebnis von {@link unarchivePage} — 403 (kein
 *  Schreibrecht), 404 (Seite unbekannt ODER nie released, s. Server-
 *  Kommentar `apps/api/src/drafts/unarchive-page.ts`) und 409 (offener
 *  Entwurf/aktiver Lock) sind dokumentierte Vertragsfälle, kein Wurf (Muster
 *  {@link movePage}). */
export type UnarchivePageResult =
  | { ok: true; page: UnarchivePageInfo }
  | { ok: false; status: 403 | 404 | 409; error: string }

/** `POST /api/pages/:id/unarchive` (Feature „Unarchive") — s.
 *  `apps/api/src/routes/unarchive-page.ts`. Entfernt `archived` DIREKT auf
 *  `main`, kein Draft-Umweg (der „Bearbeiten"-Link ist bei einer archivierten
 *  Seite ausgeblendet — dieser Aufruf ist der einzige Weg zurück). */
export async function unarchivePage(pageId: string): Promise<UnarchivePageResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/unarchive`
  const res = await rawFetch(path, { method: 'POST' })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409) {
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return {
      ok: false,
      status: 409,
      error: body?.error ?? body?.reason ?? 'Diese Seite hat einen offenen Entwurf oder aktiven Lock.',
    }
  }

  if (res.status === 404) {
    const body = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 404, error: body?.reason ?? 'Seite nicht gefunden.' }
  }

  if (res.status === 403) {
    // Muster {@link movePage}: auch CSRF-Hook-403s ({status,reason}) korrekt
    // anzeigen, deshalb beide Feldnamen abgefragt.
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return { ok: false, status: 403, error: body?.error ?? body?.reason ?? 'Kein Schreibrecht für diesen Space.' }
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as UnarchivePageInfo
  return { ok: true, page: data }
}

/** Erfolgs-Shape von `PUT /api/spaces/:space/order` (Phase 3.3, „Baum-
 *  Umsortierung über `.order`-Dateien") — `path` ist die geschriebene (bzw.
 *  bei leerer `orderedIds` gelöschte) `.order`-Datei, `orderedIds` die nach
 *  Validierung tatsächlich geschriebene Reihenfolge (identisch zum Aufruf). */
export interface ReorderChildrenInfo {
  parentId: string | null
  path: string
  orderedIds: string[]
}

/** Diskriminiertes Ergebnis von {@link reorderChildren} — 400 (eine `id` in
 *  `orderedIds` ist keine direkte Kind-Seite des Elternknotens ODER kommt
 *  doppelt vor), 403 (kein Schreibrecht) und 404 (Space oder `parentId`
 *  unbekannt) sind dokumentierte Vertragsfälle, kein Wurf — der Baum
 *  (`components/tree.tsx`) rollt bei einem Fehler die optimistische
 *  Neuordnung zurück und zeigt eine Meldung statt einer generischen
 *  Fehlerkarte. */
export type ReorderChildrenResult =
  | { ok: true; result: ReorderChildrenInfo }
  | { ok: false; status: 400 | 403 | 404; error: string }

/** `PUT /api/spaces/:space/order` (Phase 3.3) — s.
 *  `apps/api/src/routes/reorder.ts`. `parentId` referenziert den
 *  Elternknoten, dessen Kinder umsortiert werden (`null` = Space-Wurzel,
 *  s. Server-Kommentar zur Gruppierung); `orderedIds` sind die Kind-Ids in
 *  gewünschter Reihenfolge. */
export async function reorderChildren(
  space: string,
  parentId: string | null,
  orderedIds: readonly string[],
): Promise<ReorderChildrenResult> {
  const path = `/api/spaces/${encodeURIComponent(space)}/order`
  const res = await rawFetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId, orderedIds }),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 400 || res.status === 404) {
    const body2 = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: res.status, error: body2?.reason ?? 'Umsortieren nicht möglich.' }
  }

  if (res.status === 403) {
    // Wie {@link movePage}: auch CSRF-Hook-403s ({status,reason}) korrekt anzeigen.
    const body2 = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return { ok: false, status: 403, error: body2?.error ?? body2?.reason ?? 'Kein Schreibrecht für diesen Space.' }
  }

  if (!res.ok) {
    const errBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, errBody)
  }

  const data = (await res.json()) as ReorderChildrenInfo
  return { ok: true, result: data }
}

/** `POST /api/pages/:id/draft/media` — Multipart-Upload (Feld `file`) in den
 *  bestehenden Draft. 413/415/422 tragen die präzise Server-Meldung im
 *  `reason`-Feld ({@link UploadError}, NICHT {@link ClientApiError} — der
 *  Aufrufer zeigt sie direkt an, ohne generische Fehlerkarte). */
export async function uploadMedia(pageId: string, file: File | Blob, t: T = DEFAULT_T): Promise<UploadMediaResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/draft/media`
  const formData = new FormData()
  formData.append('file', file)

  const res = await rawFetch(path, { method: 'POST', body: formData })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 413 || res.status === 415 || res.status === 422) {
    const body = (await readJsonBody(res)) as { reason?: string } | undefined
    throw new UploadError(res.status, body?.reason ?? t('editor.clientApi.uploadFailedDefault'))
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  return (await res.json()) as UploadMediaResult
}

/** Diskriminiertes Ergebnis von {@link saveDiagram} — der 409 ("Ziel existiert
 *  bereits", NUR bei `ifAbsent: true` möglich, s. `apps/api/src/drafts/diagram.ts`
 *  `DiagramExistsError`) ist wie bei {@link saveDraft} ein erwarteter
 *  Vertragsfall, kein Wurf: der Aufrufer (Task 4/5, „Neuanlage"-Flow) fragt
 *  den Nutzer dann nach einem anderen Namen statt eine generische
 *  Fehlerkarte zu zeigen. */
export type SaveDiagramResult = { ok: true; path: string } | { ok: false; reason: 'exists' }

/** `PUT /api/pages/:id/draft/diagram` — legt ein Diagramm an (`ifAbsent`)
 *  oder überschreibt es in place (Task-2-Route, `apps/api/src/routes/drafts.ts`).
 *  409 ist ein diskriminiertes Ergebnis (Muster {@link saveDraft}), alle
 *  übrigen Fehler laufen über die etablierte Fehlerklassifizierung der Datei. */
export async function saveDiagram(
  pageId: string,
  input: { path: string; content: string; ifAbsent?: boolean },
): Promise<SaveDiagramResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/draft/diagram`
  const res = await rawFetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409) return { ok: false, reason: 'exists' }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as { path: string }
  return { ok: true, path: data.path }
}

/** Lädt den aktuellen Draft-Stand einer Diagramm-Datei als SVG-Text — über
 *  die Media-Route (`ref=draft`, s. {@link mediaHref}), kein eigener
 *  API-Endpunkt. */
export async function loadDiagram(pageId: string, path: string): Promise<string> {
  const url = mediaHref(pageId, path, 'draft')
  const res = await rawFetch(url)

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (!res.ok) throw new ClientApiError(res.status, `Diagramm nicht ladbar (${res.status})`, undefined)
  return res.text()
}

/** `PUT /api/locks/:pageId` — Heartbeat, übernimmt/verlängert den eigenen
 *  Lock oder liefert Auskunft über einen fremden (immer `200`, reiner
 *  Hinweis-Charakter). */
export function heartbeatLock(pageId: string): Promise<LockInfo> {
  return request<LockInfo>(`/api/locks/${encodeURIComponent(pageId)}`, { method: 'PUT' })
}

/** `DELETE /api/locks/:pageId` — löst den eigenen Lock (idempotent, `204`).
 *  `keepalive: true` für den Unmount-Pfad: die Anfrage darf den
 *  Navigations-/Tab-Close-Moment überleben (Browser hält sie offen, statt
 *  sie mit dem verworfenen Dokument abzubrechen). */
export async function releaseLock(pageId: string): Promise<void> {
  await request<void>(`/api/locks/${encodeURIComponent(pageId)}`, { method: 'DELETE', keepalive: true })
}

/** `GET /api/search` — dieselbe Query-Bauweise (manuelles `encodeURIComponent`
 *  je Parameter) wie `components/search-dialog.tsx`, statt `URLSearchParams`
 *  (dessen `application/x-www-form-urlencoded`-Kodierung Leerzeichen als `+`
 *  statt `%20` schreibt — inkonsistent zum Rest der Codebase). */
export function searchPages(q: string, options: SearchPagesOptions = {}): Promise<SearchResult[]> {
  const params = [`q=${encodeURIComponent(q)}`]
  if (options.space) params.push(`space=${encodeURIComponent(options.space)}`)
  if (options.ref) params.push(`ref=${encodeURIComponent(options.ref)}`)
  if (options.prefix) params.push('prefix=true')
  return request<SearchResult[]>(`/api/search?${params.join('&')}`)
}

// =============================================================================
// Workflow-API (Phase 2d Task 6) — s. Modul-Kommentar oben.
// =============================================================================

/** Erfolgs-Shape von `POST /api/pages/:id/review`. */
export interface ReviewInfo {
  number: number
  url: string
  state: 'review'
  mergeable: boolean | null
}

/** Diskriminiertes Ergebnis von {@link requestReview} — der 409 („kein
 *  Entwurf vorhanden") ist ein erwarteter Vertragsfall, kein Wurf. In der
 *  Praxis sollte er im Editor nie auftreten (der Draft existiert bereits,
 *  bevor der „Review anfordern"-Button überhaupt sichtbar ist), bleibt aber
 *  Teil des Vertrags — ein zwischenzeitlich verworfener Draft (z. B. zweiter
 *  Tab) darf nicht als generischer Fehler erscheinen. `reason:'no-changes'`
 *  (Fix #11) ist der HÄUFIGERE Fall: der Draft existiert, hat aber noch
 *  keinen einzigen Commit gegenüber main — ein „Review anfordern" auf einer
 *  unbearbeiteten Seite. */
export type RequestReviewResult =
  | { ok: true; review: ReviewInfo }
  | { ok: false; reason: 'no-draft' }
  | { ok: false; reason: 'no-changes' }

/** `POST /api/pages/:id/review` — eröffnet (oder liefert idempotent) den
 *  Review-PR. `mergeable:false` in der Antwort ist KEIN Fehlerfall hier —
 *  der Aufrufer navigiert trotzdem zur Review-Route (Brief: die
 *  Konflikt-Notice dort zeigt den Zustand). */
export async function requestReview(pageId: string, reviewers?: string[]): Promise<RequestReviewResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/review`
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reviewers ? { reviewers } : {}),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409) return { ok: false, reason: 'no-draft' }

  if (res.status === 422) {
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    if (body?.reason === 'no_changes') return { ok: false, reason: 'no-changes' }
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as ReviewInfo
  return { ok: true, review: data }
}

/** Erfolgs-Shape von `POST /api/pages/:id/release`. */
export interface ReleaseInfo {
  mergeSha: string
  approveWarning?: string
  /** Seitenversionierung Etappe 1 (Task 9): die neu vergebene Version — nur
   *  gesetzt, wenn der Space versioniert ist (der Dialog hat dann `bump`
   *  mitgeschickt, s. `ReleaseOptions`). Fehlt in unversionierten Spaces. */
  version?: string
}

/** Optionen für {@link releasePage}. Bewusst EIN Optionsobjekt statt
 *  Stellungsparametern (Task 9, Signaturänderung von `(pageId, comment?)`):
 *  bei drei optionalen Werten wäre `releasePage(id, undefined, 'minor',
 *  note)` an der Aufrufstelle nicht mehr lesbar. */
export interface ReleaseOptions {
  /** Kommentar am Pull Request — Kontext für die Review, NICHT dauerhafter
   *  Dokumentinhalt (s. `note`). */
  comment?: string
  /** Sprunggröße der Version — wirkt nur in versionierten Spaces; die API
   *  ignoriert das Feld sonst (s. `apps/api/README.md`). */
  bump?: 'patch' | 'minor' | 'major'
  /** Änderungsnotiz für den Changelog der Seite — dauerhafter Inhalt für
   *  spätere Leser, bewusst getrennt vom PR-`comment` (der nur Kontext für
   *  DIESE Review ist und nicht im Dokument landet). */
  note?: string
}

/** Diskriminiertes Ergebnis von {@link releasePage} — 403 (kein
 *  Freigabe-Recht auf dem Merge selbst, ANDERS als das generische
 *  Schreibrecht-403 der Gate-Kette), 409 (kein offener PR ODER
 *  Merge-Konflikt, unterschieden über `reason:'conflict'`) und 422 (Fix #11:
 *  der offene PR hat gegenüber main keinen einzigen Commit — nichts zu
 *  veröffentlichen) sind dokumentierte Vertragsfälle (`apps/api/README.md`),
 *  kein Wurf. */
export type ReleasePageResult =
  | { ok: true; result: ReleaseInfo }
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 409; error: string; reason?: 'conflict' }
  | { ok: false; status: 422; reason: 'no_changes' }

/** `POST /api/pages/:id/release` — Freigeben & mergen. NUR client-api-Typ in
 *  Phase 2d Task 6, die UI (Freigeben-Button auf der Review-Seite) folgt in
 *  Task 7; `bump`/`note` (Versionierung) kommen in Task 9 dazu.
 *
 *  Leere/fehlende Felder werden NICHT mitgeschickt (leerer Body statt
 *  `{comment: undefined, ...}`) — schlanker Server-Vertrag, identisch zum
 *  bisherigen `comment`-Verhalten. */
export async function releasePage(pageId: string, options: ReleaseOptions = {}): Promise<ReleasePageResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/release`
  const body: Record<string, string> = {}
  if (options.comment?.trim()) body.comment = options.comment.trim()
  if (options.bump) body.bump = options.bump
  if (options.note?.trim()) body.note = options.note.trim()

  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 403) {
    // Fix-Runde 1 (Review 4a-3, Finding 2): neben den Routen-403s ({error})
    // kann seit dem CSRF-Origin-Check (Phase 4a Task 3) auch ein Hook-403 im
    // {status,reason}-Format ankommen — `reason` als zweite Quelle lesen,
    // damit der Nutzer "Ungültige Origin." statt einer falschen
    // Rechte-Diagnose sieht. Reihenfolge error→reason, damit Bestands-403s
    // unverändert bleiben.
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return { ok: false, status: 403, error: body?.error ?? body?.reason ?? 'Kein Freigabe-Recht auf dieses Repository.' }
  }

  if (res.status === 409) {
    const body = (await readJsonBody(res)) as { error?: string; reason?: 'conflict' } | undefined
    return {
      ok: false,
      status: 409,
      error: body?.error ?? 'Kein offener Pull Request vorhanden.',
      reason: body?.reason,
    }
  }

  if (res.status === 422) {
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    if (body?.reason === 'no_changes') return { ok: false, status: 422, reason: 'no_changes' }
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as ReleaseInfo
  return { ok: true, result: data }
}

/** Diskriminiertes Ergebnis von {@link requestChanges} — 409 (kein offener
 *  PR) und 422 (Provider-Fehler 1:1 durchgereicht, z. B. Self-Request) sind
 *  dokumentierte Vertragsfälle. */
export type RequestChangesResult = { ok: true } | { ok: false; status: 409 | 422; error: string }

/** `POST /api/pages/:id/review/request-changes` — Kommentar ist Pflicht (Body
 *  `{comment}`). NUR client-api-Typ in Phase 2d Task 6, UI folgt in Task 7. */
export async function requestChanges(pageId: string, comment: string): Promise<RequestChangesResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/review/request-changes`
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment }),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409 || res.status === 422) {
    const body = (await readJsonBody(res)) as { error?: string } | undefined
    return { ok: false, status: res.status, error: body?.error ?? 'Änderungen konnten nicht angefordert werden.' }
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  return { ok: true }
}

/** `strategy` von `POST /api/pages/:id/draft/update` — s. `apps/api/README.md`
 *  Abschnitt „Workflow-API" für die Semantik beider Strategien. */
export type UpdateDraftStrategy = 'take-main' | 'keep-mine'

/** Erfolgs-Shape von `POST /api/pages/:id/draft/update`. */
export interface UpdateDraftInfo {
  baseSha: string
  content: string
  state: 'working' | 'review'
  pr: { number: number; url: string } | null
  warning?: string
}

/** Diskriminiertes Ergebnis von {@link updateDraft} — der 502 trägt bei
 *  einem Fehler NACH dem Verwerfen des alten Draft-Branchs `preservedContent`
 *  (Content-Verlust-Fenster, `apps/api/README.md`): der zuletzt bekannte
 *  Inhalt, typisiert zugreifbar statt in einem generischen Fehlerkörper
 *  vergraben — „kein stiller Verlust" gilt auch hier. Ein 502 VOR dem
 *  Verwerfen hat kein `preservedContent` (nichts zu retten, der alte
 *  Draft-Branch existiert unverändert weiter). */
export type UpdateDraftResult = { ok: true; info: UpdateDraftInfo } | { ok: false; message: string; preservedContent?: string }

/** `POST /api/pages/:id/draft/update` — löst den Randfall „Draft und main
 *  sind auseinandergelaufen" auf. */
export async function updateDraft(pageId: string, strategy: UpdateDraftStrategy): Promise<UpdateDraftResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/draft/update`
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy }),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 502) {
    const body = (await readJsonBody(res)) as { reason?: string; preservedContent?: string } | undefined
    return { ok: false, message: body?.reason ?? 'Provider nicht erreichbar.', preservedContent: body?.preservedContent }
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as UpdateDraftInfo
  return { ok: true, info: data }
}

/** Ein Eintrag aus `GET /api/spaces/:space/templates` (Phase 3c Task 2/5) —
 *  `source` unterscheidet ein Space-lokales Template von einem globalen
 *  (Badge „global" im Neue-Seite-Dialog). */
export interface TemplateSummary {
  id: string
  name: string
  description: string
  source: 'space' | 'global'
}

/** `GET /api/spaces/:space/templates` — Vorlagen-Liste für den
 *  Neue-Seite-Dialog, nach dem {@link searchPages}-Muster. Fehler werfen
 *  {@link ClientApiError} (bewusst KEIN diskriminiertes Ergebnis — der Dialog
 *  degradiert dafür auf die Option „Leer", statt einen Vertragsfall
 *  darzustellen). */
export function listTemplates(space: string): Promise<TemplateSummary[]> {
  return request<TemplateSummary[]>(`/api/spaces/${encodeURIComponent(space)}/templates`)
}

/** Erfolgs-Shape von `POST /api/pages` (identisch zur Draft-Antwort, s.
 *  `apps/api/README.md`: „der Editor kann die Antwort direkt öffnen"). */
export interface CreatePageInfo {
  id: string
  space: string
  path: string
  branch: string
  baseSha: string
  content: string
}

/** Diskriminiertes Ergebnis von {@link createPage} — 400 (ungültiger
 *  Titel-Slug), 403 (kein Schreibrecht) und 409 (Kollision, trägt `pageId`
 *  der bestehenden Seite für einen direkten Link) sind dokumentierte
 *  Vertragsfälle, kein Wurf: der Neue-Seite-Dialog zeigt daraus eine
 *  spezifische Meldung statt einer generischen Fehlerkarte. */
export type CreatePageResult =
  | { ok: true; page: CreatePageInfo }
  | { ok: false; status: 400 | 403; error: string }
  | { ok: false; status: 409; error: string; pageId: string }

/** `POST /api/pages` — legt eine noch nie released Seite als Draft-only-Seite
 *  an (kein Commit auf `main`). `parentId` referenziert eine bestehende Seite
 *  (main oder draft-only); ohne sie landet die neue Seite an der Space-Wurzel.
 *  `templateId` (Phase 3c Task 3/5) referenziert eine {@link TemplateSummary}
 *  aus {@link listTemplates} — ohne sie startet die Seite leer. */
export async function createPage(
  space: string,
  title: string,
  parentId?: string,
  templateId?: string,
): Promise<CreatePageResult> {
  const path = '/api/pages'
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      space,
      title,
      ...(parentId ? { parentId } : {}),
      ...(templateId ? { templateId } : {}),
    }),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 409) {
    const body = (await readJsonBody(res)) as { error?: string; pageId?: string } | undefined
    // Das Server-Schema garantiert `pageId` bei 409 (collisionSchema, s.
    // `apps/api/src/routes/create-page.ts`) — fehlt es dennoch (defekter
    // Proxy, abgeschnittener Body), wäre eine Kollisionsmeldung ohne Link
    // sinnlos: als generischen Fehler behandeln statt zu crashen (Muster
    // {@link saveDraft}).
    if (typeof body?.pageId !== 'string') {
      throw new ClientApiError(res.status, `409 ohne pageId für ${path}`, body)
    }
    return { ok: false, status: 409, error: body?.error ?? 'Unter diesem Titel existiert bereits eine Seite.', pageId: body.pageId }
  }

  if (res.status === 400) {
    const body = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 400, error: body?.reason ?? 'Ungültiger Titel.' }
  }

  if (res.status === 403) {
    // Fix-Runde 1 (Review 4a-3, Finding 2): auch CSRF-Hook-403s
    // ({status,reason}) korrekt anzeigen — s. Kommentar in {@link releasePage}.
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return { ok: false, status: 403, error: body?.error ?? body?.reason ?? 'Kein Schreibrecht für diesen Space.' }
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as CreatePageInfo
  return { ok: true, page: data }
}

/** Diskriminiertes Ergebnis von {@link saveAsTemplate} — 400 (ungültiger/leerer
 *  Name oder fehlender `content`), 403 (kein Schreibrecht auf `main` des
 *  Space-Repos — DIREKT-Commit, kein Draft-Umweg, s. `apps/api/README.md`
 *  Abschnitt „POST /api/spaces/:space/templates") und 409 (unter dem aus dem
 *  Namen abgeleiteten Pfad existiert bereits ein Template, reine Anlage, nie
 *  ein Überschreiben) sind dokumentierte Vertragsfälle, kein Wurf — der Dialog
 *  zeigt daraus eine spezifische Meldung statt einer generischen Fehlerkarte.
 *  `error` normalisiert die je nach Status unterschiedlichen Server-Feldnamen
 *  (`reason` bei 400, `error` bei 403/409) auf ein einheitliches Feld. */
export type SaveAsTemplateResult =
  | { ok: true; file: string; path: string }
  | { ok: false; status: 400 | 403 | 409; error: string }

/** `POST /api/spaces/:space/templates` — „Als Vorlage speichern" (Phase 3c
 *  Task 6): übernimmt den aktuellen Editor-Inhalt (`content`, inkl. Seiten-
 *  Frontmatter — der Server trennt es über `splitFrontmatter`) als neue
 *  Space-Vorlage. Committet DIREKT auf `main` (kein Draft-Branch/Review),
 *  s. Modul-Kommentar `apps/api/README.md`. */
export async function saveAsTemplate(
  space: string,
  body: { name: string; description?: string; content: string },
  t: T = DEFAULT_T,
): Promise<SaveAsTemplateResult> {
  const path = `/api/spaces/${encodeURIComponent(space)}/templates`
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 400) {
    const responseBody = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 400, error: responseBody?.reason ?? t('editor.clientApi.invalidTemplateName') }
  }

  if (res.status === 403) {
    // Fix-Runde 1 (Review 4a-3, Finding 2): auch CSRF-Hook-403s
    // ({status,reason}) korrekt anzeigen — s. Kommentar in {@link releasePage}.
    const responseBody = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return {
      ok: false,
      status: 403,
      error: responseBody?.error ?? responseBody?.reason ?? t('editor.clientApi.noTemplatePermission'),
    }
  }

  if (res.status === 409) {
    const responseBody = (await readJsonBody(res)) as { error?: string } | undefined
    return { ok: false, status: 409, error: responseBody?.error ?? t('editor.clientApi.templateNameExists') }
  }

  if (!res.ok) {
    const responseBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, responseBody)
  }

  const data = (await res.json()) as { file: string; path: string }
  return { ok: true, file: data.file, path: data.path }
}

// =============================================================================
// Metadaten-Schema-API (Metadaten-Feature M4 — Schema-Editor-UI). Verträge aus
// `apps/api/src/routes/metadata-schema.ts`:
// - `GET /api/spaces/:space/metadata-schema` → `200 {fields: [...]}`, IMMER
//   (fail-soft, s. dortiger Loader-Kommentar) — kein diskriminiertes Ergebnis
//   nötig, Muster {@link listTemplates}.
// - `PUT /api/spaces/:space/metadata-schema` `{fields: [...]}` → `200
//   {fields: [...]}` (das validierte, ggf. neu sortierte Schema) | `400
//   {status,reason,errors}` (Validierungsfehler je Feld) | `403 {error}`
//   (kein Schreibrecht auf `main`) — s. {@link saveMetadataSchema}. `404`
//   (unbekannter/unlesbarer Space) ist hier bewusst KEIN diskriminierter
//   Fall (Muster {@link getReview}s 502-Fall): der Editor kann nur auf einer
//   Seite eines bereits geladenen, lesbaren Spaces geöffnet werden — ein 404
//   an dieser Stelle wäre ein unerwarteter Zustand, kein Nutzer-Vertragsfall.
// =============================================================================

/** `GET /api/spaces/:space/metadata-schema` — aktuelles Schema für den
 *  Schema-Editor. Fehler werfen {@link ClientApiError} (kein diskriminiertes
 *  Ergebnis nötig — die Route selbst ist fail-soft und liefert bei jedem
 *  Space, den der Editor überhaupt anzeigen kann, ein `200`). */
export function getMetadataSchema(space: string): Promise<MetadataSchema> {
  return request<MetadataSchema>(apiSpaceMetadataSchemaPath(space))
}

/** Diskriminiertes Ergebnis von {@link saveMetadataSchema} — 400
 *  (Validierungsfehler, `errors` trägt die Einzelbefunde für die
 *  Feld-für-Feld-Anzeige im Editor) und 403 (kein Schreibrecht auf `main` des
 *  Space-Repos — DIREKT-Commit wie bei Templates) sind dokumentierte
 *  Vertragsfälle, kein Wurf. */
export type SaveMetadataSchemaResult =
  | { ok: true; schema: MetadataSchema }
  | { ok: false; status: 400; error: string; errors: string[] }
  | { ok: false; status: 403; error: string }

/** `PUT /api/spaces/:space/metadata-schema` — speichert das Schema DIREKT auf
 *  `main` (kein Draft-Umweg, Muster {@link saveAsTemplate}). Der Server
 *  validiert serverseitig erneut (Muster: nie dem Client vertrauen) — der
 *  Editor sollte trotzdem client-seitig (`lib/metadata-schema-form.ts`)
 *  vorab prüfen, um dem Nutzer nicht erst nach einem Roundtrip Fehler zu
 *  zeigen. */
export async function saveMetadataSchema(space: string, schema: MetadataSchema): Promise<SaveMetadataSchemaResult> {
  const path = apiSpaceMetadataSchemaPath(space)
  const res = await rawFetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(schema),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 400) {
    const body = (await readJsonBody(res)) as { reason?: string; errors?: string[] } | undefined
    return { ok: false, status: 400, error: body?.reason ?? 'Ungültiges Schema.', errors: body?.errors ?? [] }
  }

  if (res.status === 403) {
    // Fix-Runde 1 (Review 4a-3, Finding 2): auch CSRF-Hook-403s
    // ({status,reason}) korrekt anzeigen — s. Kommentar in {@link releasePage}.
    const body = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return {
      ok: false,
      status: 403,
      error: body?.error ?? body?.reason ?? 'Kein Recht, das Metadaten-Schema in diesem Space zu ändern.',
    }
  }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as MetadataSchema
  return { ok: true, schema: data }
}

/** Diff-Shape von `GET /api/pages/:id/review` — `diff` ist seit Task 7
 *  (`components/review/diff-view.tsx`) voll typisiert (`MarkdownDiff` aus
 *  `@f451/markdown`, bereits Abhängigkeit von `@f451/web`) statt `unknown`,
 *  kein dupliziertes Typ-Modell hier. Ungenutzt von der Review-SEITE selbst
 *  (die lädt server-seitig direkt über `lib/api.ts#apiFetch`, Muster
 *  `edit/page.tsx`) — {@link getReview} bleibt als client-seitiger Helfer für
 *  potenzielle künftige Re-Fetches erhalten. */
export interface ReviewDiffInfo {
  pr: { number: number; url: string; state: string; mergeable: boolean | null; title: string }
  authorName: string
  diff: MarkdownDiff
  page: { id: string; space: string; title: string }
}

/** Diskriminiertes Ergebnis von {@link getReview} — 404 („kein offenes
 *  Review") ist ein dokumentierter Vertragsfall, kein Wurf. */
export type GetReviewResult = { ok: true; review: ReviewDiffInfo } | { ok: false; reason: 'not-open' }

/** `GET /api/pages/:id/review` — visuelles Diff für die Review-Ansicht. NUR
 *  client-api-Typ in Phase 2d Task 6, die Review-Seite selbst ist Task 7. */
export async function getReview(pageId: string): Promise<GetReviewResult> {
  const path = `/api/pages/${encodeURIComponent(pageId)}/review`
  const res = await rawFetch(path)

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 404) return { ok: false, reason: 'not-open' }

  if (!res.ok) {
    const body = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  const data = (await res.json()) as ReviewDiffInfo
  return { ok: true, review: data }
}

// =============================================================================
// Vorlagen-Pflege (Werkzeuge-Bereich „Vorlagen") — GET-Einzelansicht (mit
// Inhalt) + PATCH/DELETE-Gegenstücke zu {@link saveAsTemplate}/
// {@link listTemplates}. Verträge aus `apps/api/src/routes/templates.ts`:
// - `GET /api/spaces/:space/templates/:id` → `200 {id, name, description,
//   body, source}` — anders als {@link listTemplates} (schlanke
//   Zusammenfassung für den Neue-Seite-Dialog) MIT vollem Body, für die
//   Bearbeiten-UI der Vorlagen-Pflege. `404` (Vorlage inzwischen gelöscht,
//   z. B. durch eine andere Person zwischen Listen-Laden und „Bearbeiten"-
//   Klick) IST hier ein dokumentierter Vertragsfall (anders als
//   {@link getMetadataSchema}, dessen Seite immer existiert) — s.
//   {@link getTemplate}.
// - `PATCH /api/spaces/:space/templates/:id` `{name?, description?, content?}`
//   → `200 {id, name, description, path}` (das aktualisierte Template — `id`
//   ändert sich bei einer Namensänderung, s. {@link renameTemplate}-Kommentar)
//   | `400 {status,reason}` (leerer/slug-loser Name, falscher Feldtyp) | `403
//   {error}` (kein Schreibrecht ODER `id` referenziert eine GLOBALE Vorlage —
//   die sind schreibgeschützt) | `404 {status,reason}` (unbekannte Vorlage/
//   Space) | `409 {error,file}` (Namensänderung kollidiert mit einer
//   bestehenden Vorlage) — s. {@link updateTemplate}/{@link renameTemplate}.
// - `DELETE /api/spaces/:space/templates/:id` → `204` | `403 {error}` (kein
//   Schreibrecht ODER globale Vorlage) | `404 {status,reason}` — s.
//   {@link deleteTemplate}.
// =============================================================================

/** Antwort-Shape von `GET /api/spaces/:space/templates/:id` — {@link TemplateSummary}
 *  plus `body` (voller Markdown-Inhalt ohne Frontmatter). */
export interface TemplateDetail {
  id: string
  name: string
  description: string
  body: string
  source: 'space' | 'global'
}

/** Diskriminiertes Ergebnis von {@link getTemplate} — der 404-Fall ist
 *  dokumentiert (s. Modul-Kommentar oben), kein Wurf. */
export type GetTemplateResult = { ok: true; template: TemplateDetail } | { ok: false; status: 404; error: string }

/** `GET /api/spaces/:space/templates/:id` — lädt eine einzelne Vorlage MIT
 *  Inhalt für die Bearbeiten-Ansicht der Vorlagen-Pflege. */
export async function getTemplate(space: string, id: string): Promise<GetTemplateResult> {
  const path = `/api/spaces/${encodeURIComponent(space)}/templates/${encodeURIComponent(id)}`
  const res = await rawFetch(path)

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 404) {
    const responseBody = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 404, error: responseBody?.reason ?? 'Vorlage nicht gefunden.' }
  }

  if (!res.ok) {
    const responseBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, responseBody)
  }

  const data = (await res.json()) as TemplateDetail
  return { ok: true, template: data }
}

/** Diskriminiertes Ergebnis von {@link updateTemplate}/{@link renameTemplate}
 *  — 400/403/404/409 sind dokumentierte Vertragsfälle (Muster
 *  {@link saveAsTemplate}), kein Wurf. */
export type UpdateTemplateResult =
  | { ok: true; id: string; name: string; description: string; path: string }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string }

/** Gemeinsamer Request-Pfad für {@link updateTemplate}/{@link renameTemplate}
 *  — beide sind dieselbe `PATCH`-Route mit unterschiedlichem Body-Ausschnitt
 *  (echte PATCH-Semantik server-seitig: ein nicht mitgeschicktes Feld bleibt
 *  unverändert, s. Routen-Kommentar). */
async function patchTemplateRequest(
  space: string,
  id: string,
  body: { name?: string; description?: string; content?: string },
): Promise<UpdateTemplateResult> {
  const path = `/api/spaces/${encodeURIComponent(space)}/templates/${encodeURIComponent(id)}`
  const res = await rawFetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 400) {
    const responseBody = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 400, error: responseBody?.reason ?? 'Ungültige Eingabe.' }
  }

  if (res.status === 403) {
    // Muster {@link saveAsTemplate}: auch CSRF-Hook-403s ({status,reason})
    // korrekt anzeigen, deshalb beide Feldnamen abgefragt.
    const responseBody = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return {
      ok: false,
      status: 403,
      error: responseBody?.error ?? responseBody?.reason ?? 'Kein Recht, diese Vorlage zu bearbeiten.',
    }
  }

  if (res.status === 404) {
    const responseBody = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 404, error: responseBody?.reason ?? 'Vorlage nicht gefunden.' }
  }

  if (res.status === 409) {
    const responseBody = (await readJsonBody(res)) as { error?: string } | undefined
    return {
      ok: false,
      status: 409,
      error: responseBody?.error ?? 'Unter diesem Namen existiert bereits ein Template.',
    }
  }

  if (!res.ok) {
    const responseBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, responseBody)
  }

  const data = (await res.json()) as { id: string; name: string; description: string; path: string }
  return { ok: true, ...data }
}

/** `PATCH /api/spaces/:space/templates/:id` — bearbeitet NUR den Inhalt
 *  (Roh-Markdown-Body, Rohtext-Textarea in der Vorlagen-Pflege-UI) einer
 *  SPACE-Vorlage, Name/Beschreibung bleiben unverändert (dafür s.
 *  {@link renameTemplate} — eigene Funktion/eigener Formkontext in der UI:
 *  „Inhalt bearbeiten" vs. „Umbenennen" sind zwei getrennte Aktionen). */
export function updateTemplate(space: string, id: string, content: string): Promise<UpdateTemplateResult> {
  return patchTemplateRequest(space, id, { content })
}

/** `PATCH /api/spaces/:space/templates/:id` mit `name`/`description` — benennt
 *  eine SPACE-Vorlage um bzw. ändert ihre Beschreibung (die „Umbenennen"-
 *  Aktion der Vorlagen-Pflege-UI, Name UND Beschreibung in einem Formular).
 *  Ändert sich durch den neuen Namen der Datei-Slug, benennt der Server die
 *  Datei um (zwei Commits: neue Datei anlegen, alte löschen) — die
 *  zurückgegebene `id` weicht dann von der aufgerufenen `id` ab; die
 *  Vorlagen-Pflege-Seite lädt danach ihre Liste neu ({@link listTemplates})
 *  statt die alte `id` weiterzuverwenden. */
export function renameTemplate(
  space: string,
  id: string,
  body: { name: string; description?: string },
): Promise<UpdateTemplateResult> {
  return patchTemplateRequest(space, id, body)
}

/** Diskriminiertes Ergebnis von {@link deleteTemplate} — 403/404 sind
 *  dokumentierte Vertragsfälle (Muster {@link saveAsTemplate}), kein Wurf. */
export type DeleteTemplateResult = { ok: true } | { ok: false; status: 403 | 404; error: string }

/** `DELETE /api/spaces/:space/templates/:id` — löscht eine SPACE-Vorlage
 *  (Vorlagen-Pflege). */
export async function deleteTemplate(space: string, id: string): Promise<DeleteTemplateResult> {
  const path = `/api/spaces/${encodeURIComponent(space)}/templates/${encodeURIComponent(id)}`
  const res = await rawFetch(path, { method: 'DELETE' })

  if (res.status === 401) {
    redirectToLogin()
    throw new SessionExpiredError()
  }

  if (res.status === 403) {
    const responseBody = (await readJsonBody(res)) as { error?: string; reason?: string } | undefined
    return {
      ok: false,
      status: 403,
      error: responseBody?.error ?? responseBody?.reason ?? 'Kein Recht, diese Vorlage zu löschen.',
    }
  }

  if (res.status === 404) {
    const responseBody = (await readJsonBody(res)) as { reason?: string } | undefined
    return { ok: false, status: 404, error: responseBody?.reason ?? 'Vorlage nicht gefunden.' }
  }

  if (!res.ok) {
    const responseBody = await readJsonBody(res)
    throw new ClientApiError(res.status, `API antwortete mit ${res.status} für ${path}`, responseBody)
  }

  return { ok: true }
}
