import { ProviderError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import {
  GITHUB_TOKEN_URL,
  getUserProviderTokens,
  markNeedsReconnect,
  updateProviderTokens,
  type ConnectOptions,
  type ConnectProvider,
} from './connect.js'

/**
 * Provider-Token-Refresh (Task 4b/4, Spec §9 „Token-Refresh automatisch"):
 * bislang wurde der bei der Kontoverknüpfung gespeicherte `encryptedRefreshToken`
 * NIE wieder eingelöst — ein abgelaufenes Provider-Token führte zum harten
 * Re-Login statt zur stillen Erneuerung. Diese Datei löst ihn bei Bedarf
 * (401-Antwort des Providers) beim Token-Endpoint ein und persistiert die neuen
 * Tokens über die Bestands-Krypto aus Phase 1d (`crypto.ts`, hier indirekt über
 * `connect.ts#updateProviderTokens`) — es wird KEINE neue Verschlüsselung gebaut.
 */

export class TokenRefreshError extends Error {}

export interface TokenRefreshDeps {
  db: Db
  /** Schlüssel zur Ent-/Verschlüsselung des Provider-Tokens (F451_TOKEN_KEY). */
  tokenKey: string
  /** OAuth-Client-Konfiguration (Forgejo-Basis-URL + Client-Credentials aus dem
   *  Connect-Flow, `auth/connect.ts`) — ohne konfigurierten Provider darin ist
   *  kein Refresh möglich (siehe `doRefresh`). */
  connect: ConnectOptions
  /** Injectbare fetch-Funktion (Default: globales fetch) — für Tests. */
  fetch?: typeof fetch
  /** Ziel für die Warnung bei gescheitertem Refresh (Issue #70). Ohne sie
   *  bliebe ein toter Refresh-Token unsichtbar: die Berechtigungs-Probe wertet
   *  ihn still als „kein Zugriff", und der Nutzer sieht nur eine leere Liste. */
  log?: { warn: (obj: object, msg: string) => void }
}

// Pro (userId, provider) höchstens EIN Refresh gleichzeitig unterwegs
// (Testfall e, Concurrency): ohne diese Deduplizierung würden zwei parallele
// 401-Retries desselben Nutzers beide versuchen, denselben (bei Forgejo
// rotierenden) Refresh-Token einzulösen — der zweite träfe dann auf einen
// bereits verbrauchten Token und schlüge unnötig fehl, obwohl längst ein
// frischer Token vorliegt. Ein In-Prozess-Mutex (Map von Schlüssel auf das
// laufende Promise) ist hier robuster als "Fehlschlag + DB neu lesen": es gibt
// ein echtes paralleles Zeitfenster, in dem eine zweite Anfrage die Datenbank
// VOR dem Schreiben der ersten läse und den Wettlauf fälschlich als endgültig
// gescheitert werten würde. Der Mutex verhindert den zweiten Provider-Aufruf
// von vornherein, statt eine Race-Bedingung nur abzumildern. Modul-Singleton
// wie der Berechtigungs-Cache (`permissions.ts`) — in Produktion läuft genau
// ein API-Prozess.
const inFlightRefreshes = new Map<string, Promise<string>>()

function refreshKey(userId: string, provider: ConnectProvider): string {
  return `${userId}:${provider}`
}

/**
 * Löst den gespeicherten Refresh-Token des Nutzers beim Provider-Token-Endpoint
 * ein (`grant_type=refresh_token`), persistiert die neuen Tokens verschlüsselt
 * (AES-GCM-Bestand aus 1d, siehe `connect.ts#updateProviderTokens`) und liefert
 * den neuen Access-Token. Wirft {@link TokenRefreshError}, wenn kein
 * Refresh-Token gespeichert ist, der Provider nicht konfiguriert ist oder der
 * Provider den Refresh ablehnt (z. B. widerrufen — HTTP 400 `invalid_grant`).
 *
 * Dedupliziert nebenläufige Aufrufe für denselben (userId, provider) auf EINEN
 * tatsächlichen Provider-Aufruf (siehe `inFlightRefreshes` oben).
 */
export async function refreshProviderToken(
  deps: TokenRefreshDeps,
  userId: string,
  provider: ConnectProvider,
): Promise<string> {
  const key = refreshKey(userId, provider)
  const existing = inFlightRefreshes.get(key)
  if (existing) return existing

  const promise = doRefresh(deps, userId, provider).finally(() => {
    inFlightRefreshes.delete(key)
  })
  inFlightRefreshes.set(key, promise)
  return promise
}

async function doRefresh(deps: TokenRefreshDeps, userId: string, provider: ConnectProvider): Promise<string> {
  const stored = await getUserProviderTokens(deps.db, userId, provider, deps.tokenKey)
  if (!stored?.refreshToken) {
    throw new TokenRefreshError('Kein gespeicherter Refresh-Token für diesen Nutzer/Provider.')
  }

  const doFetch = deps.fetch ?? fetch
  let res: Response

  if (provider === 'github') {
    const config = deps.connect.github
    if (!config) {
      throw new TokenRefreshError('GitHub-Kontoverknüpfung ist nicht konfiguriert — Token-Refresh nicht möglich.')
    }
    try {
      res = await doFetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: stored.refreshToken,
        }),
      })
    } catch {
      throw new TokenRefreshError('Netzwerkfehler beim GitHub-Token-Refresh.')
    }
  } else {
    const config = deps.connect.forgejo
    if (!config) {
      throw new TokenRefreshError('Forgejo-Kontoverknüpfung ist nicht konfiguriert — Token-Refresh nicht möglich.')
    }
    const tokenUrl = new URL('/login/oauth/access_token', config.baseUrl)
    try {
      res = await doFetch(tokenUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: stored.refreshToken,
        }),
      })
    } catch {
      throw new TokenRefreshError('Netzwerkfehler beim Forgejo-Token-Refresh.')
    }
  }

  if (!res.ok) {
    // `error_description` nennt den Grund („token was already used") und
    // enthält kein Token — anders als ein Erfolgs-Body.
    const detail = await res
      .json()
      .then((body: { error_description?: unknown }) =>
        typeof body.error_description === 'string' ? `: ${body.error_description}` : '',
      )
      .catch(() => '')
    // Nur eine Ablehnung durch den Provider ist endgültig — ein Netzwerkfehler
    // oben wirft vorher und markiert nichts.
    await markNeedsReconnect(deps.db, userId, provider)
    throw new TokenRefreshError(`${provider}-Token-Refresh abgelehnt (Status ${res.status}${detail}).`)
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string }
  if (!data.access_token) {
    throw new TokenRefreshError(`${provider}-Token-Refresh fehlgeschlagen (kein Access-Token in der Antwort).`)
  }

  await updateProviderTokens(
    deps.db,
    userId,
    provider,
    { accessToken: data.access_token, refreshToken: data.refresh_token },
    deps.tokenKey,
  )
  return data.access_token
}

/**
 * Führt `fn` mit dem aktuellen (entschlüsselten) Access-Token des Nutzers aus.
 * Ist kein Refresh-Token gespeichert (z. B. GitHub, `connect.ts#exchangeConnectCode`
 * fordert dort nie einen an), degradiert der Aufruf zu einem direkten
 * Durchgriff auf `fn` — kein Refresh-Versuch, kein Verhaltensbruch gegenüber
 * dem bisherigen Code.
 *
 * Ist ein Refresh-Token vorhanden und wirft `fn` einen `ProviderError` mit
 * Status 401, wird GENAU EIN Refresh + Retry versucht: Refresh-Token einlösen,
 * `fn` erneut mit dem neuen Access-Token aufrufen. Scheitert der Refresh
 * (abgelehnt/widerrufen/nicht konfiguriert), propagiert der URSPRÜNGLICHE
 * 401-Fehler unverändert (→ bestehende Re-Login-Strecke, Spec §9 Offboarding) —
 * NICHT der `TokenRefreshError`, damit Aufrufer weiterhin nur mit
 * `ProviderError` rechnen müssen. Jeder andere Fehler (kein `ProviderError`
 * oder ein anderer Status als 401) propagiert sofort, ohne jeden Refresh-Versuch.
 */
export async function withTokenRefresh<T>(
  deps: TokenRefreshDeps,
  userId: string,
  provider: ConnectProvider,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const stored = await getUserProviderTokens(deps.db, userId, provider, deps.tokenKey)
  if (!stored) {
    throw new TokenRefreshError('Kein verknüpftes Provider-Konto.')
  }

  if (!stored.refreshToken) {
    // Kein Refresh-Token gespeichert -> kein Refresh möglich, direkter
    // Durchgriff OHNE die 401-Fang-/Retry-Logik unten (Testfall c).
    return fn(stored.accessToken)
  }

  try {
    return await fn(stored.accessToken)
  } catch (err) {
    if (!(err instanceof ProviderError) || err.status !== 401) throw err

    let newToken: string
    try {
      newToken = await refreshProviderToken(deps, userId, provider)
    } catch (refreshErr) {
      // Refresh abgelehnt/nicht möglich -> ursprünglicher 401 propagiert.
      deps.log?.warn(
        { userId, provider, reason: refreshErr instanceof Error ? refreshErr.message : 'unbekannt' },
        'Token-Refresh gescheitert — die Provider-Verknüpfung muss neu hergestellt werden',
      )
      throw err
    }
    return await fn(newToken)
  }
}
