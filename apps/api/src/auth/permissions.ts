import { ProviderError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import type { SpaceConfig } from '../spaces/config.js'
import type { ConnectOptions } from './connect.js'
import { withTokenRefresh, type TokenRefreshDeps } from './token-refresh.js'

/**
 * Berechtigungs-Vererbung von der Git-Plattform (Plan Task 5, Spec Abschnitt 7):
 * Ein Space ist für einen Nutzer sichtbar/lesbar genau dann, wenn dessen
 * verknüpftes Provider-Token das zugrunde liegende Repo lesen darf. Es gibt kein
 * eigenes Rollensystem — die Wahrheit liegt beim Git-Provider.
 *
 * Die Probe ist ein GET auf den Repo-Endpunkt des Providers mit dem Nutzer-Token
 * (Forgejo `/api/v1/repos/{owner}/{repo}`, GitHub `/repos/{owner}/{repo}`).
 * 200 → lesbar; alles andere (404/403 — Provider verraten private Repos nicht,
 * daher 404) → nicht lesbar. Kein verknüpftes Konto für den Provider → nicht
 * lesbar (kein Token, keine Probe).
 *
 * Schreibrechte-Probe (Phase 2a Task 1): dieselbe Repo-Antwort enthält bei
 * beiden Providern (authentifiziert) ein `permissions`-Objekt; `push: true`
 * bedeutet Schreibrecht. Cache im eigenen Namespace (Tupel `['write', userId,
 * spaceId]`), damit Lese- und Schreib-Ergebnis unabhängig voneinander
 * ablaufen/invalidiert werden, aber mit demselben TTL/Cache-Mechanismus.
 *
 * Token-Refresh (Issue #25): ein abgelaufener Access-Token beantwortet die
 * Probe mit 401 — OHNE Refresh wäre der Space bis zu 5 min unsichtbar, obwohl
 * ein gültiger Refresh-Token gespeichert ist. `probeSpace`/`probeSpaceWrite`
 * wickeln die Probe deshalb über `withTokenRefresh` (`token-refresh.ts`) ab,
 * genau wie die Draft-/Media-Schreibpfade (`drafts/user-provider.ts`): der
 * Repo-Fetch wird bei 401 als `ProviderError` geworfen, `withTokenRefresh`
 * löst dann GENAU EINEN Refresh + Retry aus. Erfolgreiche Ergebnisse NACH
 * Refresh werden ganz normal (positiv) gecacht — nicht das zwischenzeitliche
 * 401. Kein Refresh-Token / Refresh scheitert / erneut 401 → Fail-Closed wie
 * zuvor (`false`, kein Crash, keine Token-/Repo-Details in Logs).
 *
 * Cache: In-Memory Map je `(userId, spaceId)` mit TTL 5 min (Plan Global
 * Constraints), damit nicht jede Anfrage den Provider trifft. Bei einem Disconnect
 * (`DELETE /auth/connect/:provider`) werden alle Einträge des Nutzers invalidiert
 * (`invalidateUserPermissions`), sonst würde ein zwischengespeichertes „lesbar"
 * die weggefallene Verknüpfung um bis zu 5 min überdauern. Die Invalidierung
 * erfasst BEIDE Cache-Namespaces (Lesen und Schreiben).
 */

const USER_AGENT = 'f451'
const CACHE_TTL_MS = 5 * 60 * 1000

/** Injectbare fetch-Signatur — Tests reichen einen Zähl-Wrapper/Spy herein.
 *  `json()` wird nur von der Schreibrechte-Probe benötigt (liest `permissions.push`
 *  aus dem Repo-Antwortkörper), die Lese-Probe wertet ausschließlich `status` aus. */
export type FetchFn = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>

export interface PermissionDeps {
  db: Db
  /** Schlüssel zur Entschlüsselung des Provider-Tokens (F451_TOKEN_KEY). */
  tokenKey: string
  /** Basis-URL der Forgejo-Instanz für die Repo-Probe (ohne /api/v1). Fehlt sie,
   *  können Forgejo-Spaces nicht geprüft werden → nie lesbar. */
  forgejoBaseUrl?: string
  /** OAuth-Client-Konfiguration für den Token-Refresh (Issue #25) — dieselbe
   *  Quelle wie bei der Kontoverknüpfung (`opts.auth.connect`, `app.ts`) und
   *  beim Nutzer-Provider (`drafts/user-provider.ts#UserProviderDeps.connect`).
   *  Ohne sie (oder ohne den jeweiligen Provider darin) bleibt ein 401 bei der
   *  Probe unheilbar — `withTokenRefresh` degradiert dann zum Propagieren des
   *  ursprünglichen Fehlers, hier abgefangen und als `false` gewertet
   *  (Fail-Closed, kein Verhaltensbruch gegenüber vorher). */
  connect?: ConnectOptions
  /** Injectbare fetch-Funktion (Default: globales fetch). */
  fetch?: FetchFn
  /** Injectbare Uhr (Default: Date.now) — für deterministische TTL-Tests. */
  now?: () => number
  /** Warnung bei gescheitertem Token-Refresh (Issue #70), siehe `TokenRefreshDeps.log`. */
  log?: TokenRefreshDeps['log']
}

/** Ein von Routen benutzter, schmaler Zugriffsprüfer (siehe app.ts-Verdrahtung). */
export interface SpaceAccess {
  canRead(userId: string, space: SpaceConfig): Promise<boolean>
}

interface CacheEntry {
  value: boolean
  expiresAt: number
}

// Modul-globaler Cache: In Produktion existiert genau eine App-Instanz, sodass
// ein Modul-Singleton passt und `invalidateUserPermissions` (aus connect.ts beim
// Disconnect aufgerufen) ohne Instanz-Referenz auskommt. In Tests wird er über
// `clearPermissionCache()` zwischen Fällen zurückgesetzt. Lese- und Schreib-
// Ergebnisse teilen sich denselben Map, aber unterschiedliche Tupel-Formen
// (Namespaces) — siehe cacheKey/writeCacheKey.
const cache = new Map<string, CacheEntry>()

/**
 * Kollisionssicherer Cache-Key für Leserechte: JSON.stringify eines Tupels
 * statt String-Verkettung, damit z.B. userId='a' + spaceId='b:c' nicht mit
 * userId='a:b' + spaceId='c' kollidiert (beide würden `a:b:c` ergeben, aber
 * unterschiedliche JSON-Tupel `["a","b:c"]` vs. `["a:b","c"]`).
 */
function cacheKey(userId: string, spaceId: string): string {
  return JSON.stringify([userId, spaceId])
}

/**
 * Cache-Key für Schreibrechte: eigener Namespace (führendes `'write'`-Element),
 * ebenfalls als JSON-Tupel — dieselbe Kollisionssicherheit wie `cacheKey`, aber
 * garantiert disjunkt von Lese-Keys (ein Lese-Tupel hat userId als erstes
 * Element, nie den String `'write'`, außer wenn userId selbst `'write'`
 * lautet — das kollidiert dennoch nicht, weil das zweite Tupel-Element dann
 * die spaceId statt der echten userId wäre und `invalidateUserPermissions`
 * beide Formen separat prüft, siehe dort).
 */
function writeCacheKey(userId: string, spaceId: string): string {
  return JSON.stringify(['write', userId, spaceId])
}

/** Baut URL + Basis-Header für die Repo-Probe (Lesen und Schreiben nutzen
 *  denselben Request, nur die Auswertung der Antwort unterscheidet sich).
 *  `null`, wenn eine Probe für diesen Provider grundsätzlich unmöglich ist
 *  (bei Forgejo: keine konfigurierte Basis-URL) — UNABHÄNGIG vom Access-Token,
 *  das erst pro Versuch (vor/nach Refresh) über `withTokenRefresh` eingesetzt
 *  wird (siehe `probeSpace`/`probeSpaceWrite`). */
function buildProbeUrl(deps: PermissionDeps, space: SpaceConfig): string | null {
  if (space.provider === 'github') {
    return `https://api.github.com/repos/${space.owner}/${space.repo}`
  }
  if (!deps.forgejoBaseUrl) return null
  return new URL(`/api/v1/repos/${space.owner}/${space.repo}`, deps.forgejoBaseUrl).href
}

function buildProbeHeaders(space: SpaceConfig, accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': USER_AGENT,
    Accept: space.provider === 'github' ? 'application/vnd.github+json' : 'application/json',
  }
}

/** Führt EINEN Repo-Probe-Fetch aus. Wirft bei 401 einen `ProviderError`
 *  (Status 401) statt ihn als Ergebnis zurückzugeben — das ist das Signal, auf
 *  das `withTokenRefresh` (`token-refresh.ts`) reagiert: genau ein Refresh +
 *  Retry mit dem neuen Access-Token. Jeder andere Status (inkl. 404/403) wird
 *  normal zurückgegeben und NICHT als Anlass für einen Refresh gewertet. */
async function fetchProbeOrThrow401(
  deps: PermissionDeps,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const doFetch = deps.fetch ?? (fetch as unknown as FetchFn)
  const res = await doFetch(url, { headers })
  if (res.status === 401) {
    throw new ProviderError('Provider-Repo-Probe nicht autorisiert (401).', 401, '')
  }
  return res
}

function toRefreshDeps(deps: PermissionDeps): TokenRefreshDeps {
  return { db: deps.db, tokenKey: deps.tokenKey, connect: deps.connect ?? {}, log: deps.log }
}

/** Führt die Leserechte-Probe aus (ohne Cache). Bei einem 401 wird — sofern
 *  ein Refresh-Token gespeichert und ein Provider konfiguriert ist — GENAU EIN
 *  Token-Refresh + Retry versucht (`withTokenRefresh`). Kein verknüpftes
 *  Konto, kein/abgelehnter Refresh, erneutes 401, Netzwerkfehler oder keine
 *  konfigurierte Forgejo-Basis-URL → einheitlich `false` (Fail-Closed; kein
 *  Token-/Repo-Detail landet in Logs). */
async function probeSpace(deps: PermissionDeps, userId: string, space: SpaceConfig): Promise<boolean> {
  const url = buildProbeUrl(deps, space)
  if (!url) return false

  try {
    return await withTokenRefresh(toRefreshDeps(deps), userId, space.provider, async (accessToken) => {
      const res = await fetchProbeOrThrow401(deps, url, buildProbeHeaders(space, accessToken))
      return res.status === 200
    })
  } catch {
    // TokenRefreshError (kein Konto/Refresh-Token, Refresh abgelehnt),
    // ProviderError (erneutes 401 nach gescheitertem Refresh) oder
    // Netzwerkfehler → im Zweifel nicht sichtbar.
    return false
  }
}

/** Führt die Schreibrechte-Probe aus (ohne Cache): dieselbe Repo-Antwort wie
 *  die Leserechte-Probe, ausgewertet über `permissions.push` im Body statt nur
 *  den Status. Refresh-Verhalten bei 401 wie {@link probeSpace}. */
async function probeSpaceWrite(deps: PermissionDeps, userId: string, space: SpaceConfig): Promise<boolean> {
  const url = buildProbeUrl(deps, space)
  if (!url) return false

  try {
    return await withTokenRefresh(toRefreshDeps(deps), userId, space.provider, async (accessToken) => {
      const res = await fetchProbeOrThrow401(deps, url, buildProbeHeaders(space, accessToken))
      if (res.status !== 200) return false
      const body = (await res.json()) as { permissions?: { push?: boolean } }
      return body.permissions?.push === true
    })
  } catch {
    // Netzwerkfehler/Provider nicht erreichbar, unerwartete Antwortform (kein
    // JSON) ODER erneutes 401 nach gescheitertem Refresh → Fail-Closed.
    return false
  }
}

/**
 * Prüft, ob der Nutzer den Space lesen darf. Ergebnisse (auch negative) werden
 * 5 min gecacht; ein Cache-Treffer löst KEINE Provider-Probe aus.
 */
export async function canReadSpace(deps: PermissionDeps, userId: string, space: SpaceConfig): Promise<boolean> {
  const now = deps.now ?? Date.now
  const key = cacheKey(userId, space.id)

  const cached = cache.get(key)
  if (cached && cached.expiresAt > now()) return cached.value

  const value = await probeSpace(deps, userId, space)
  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS })
  return value
}

/**
 * Prüft, ob der Nutzer in den Space schreiben darf (Phase 2a Task 1, Plan
 * Global Constraints: Vorbedingung für alle Schreibrouten). Eigener Cache-
 * Namespace, gleicher TTL/Mechanismus wie `canReadSpace`.
 */
export async function canWriteSpace(deps: PermissionDeps, userId: string, space: SpaceConfig): Promise<boolean> {
  const now = deps.now ?? Date.now
  const key = writeCacheKey(userId, space.id)

  const cached = cache.get(key)
  if (cached && cached.expiresAt > now()) return cached.value

  const value = await probeSpaceWrite(deps, userId, space)
  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS })
  return value
}

/**
 * Entfernt alle gecachten Berechtigungen eines Nutzers — sowohl Lese- als auch
 * Schreib-Namespace. Wird von connect.ts beim Disconnect (und nach einem neuen
 * Connect) aufgerufen, damit eine geänderte Verknüpfung sofort greift, statt
 * bis zu 5 min im jeweiligen Cache nachzuwirken. Jeder Key ist ein von dieser
 * Datei erzeugtes JSON-Tupel (`cacheKey`/`writeCacheKey`), daher ist das
 * Parsen hier sicher.
 */
export function invalidateUserPermissions(userId: string): void {
  for (const key of cache.keys()) {
    const tuple = JSON.parse(key) as unknown[]
    // Tupel-Länge unterscheidet die Namespaces eindeutig (Lesen: [userId,
    // spaceId], Schreiben: ['write', userId, spaceId]) — ohne die
    // Längenprüfung würde userId==='write' fälschlich alle Schreib-Einträge
    // FREMDER Nutzer treffen (tuple[0] wäre für jeden von ihnen 'write').
    const isReadEntry = tuple.length === 2 && tuple[0] === userId
    const isWriteEntry = tuple.length === 3 && tuple[0] === 'write' && tuple[1] === userId
    if (isReadEntry || isWriteEntry) cache.delete(key)
  }
}

/** Leert den gesamten Cache. Primär für Tests (Isolation zwischen Fällen). */
export function clearPermissionCache(): void {
  cache.clear()
}
