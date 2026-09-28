import { ForgejoProvider, GitHubProvider, type GitProvider } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { getUserProviderTokens, type ConnectOptions } from '../auth/connect.js'
import { withTokenRefresh, type TokenRefreshDeps } from '../auth/token-refresh.js'
import type { SpaceConfig } from '../spaces/config.js'

/**
 * Nutzer-Provider-Factory (Phase 2a Task 1, Plan Global Constraints: „User-
 * Token für alle Schreiboperationen" — echte Autorschaft, kein Bot). Anders
 * als die Service-Account-Registry (`spaces/config.ts#createProviderRegistry`,
 * EIN gecachtes Client-Paar für alle Spaces) baut `getUserProvider` bei jedem
 * Aufruf eine frische Provider-Instanz mit dem entschlüsselten Token des
 * jeweiligen Nutzers — Instanzen sind zustandslos bis auf Token/Basis-URL,
 * Caching lohnt sich hier nicht (Token kann sich durch Re-Connect ändern).
 *
 * Task 4b/4 (Token-Refresh, Spec §9): DIES ist die eine zentrale Stelle, über
 * die alle Schreib-Pfade (Draft/Save/Media/Diagramm/Workflow, siehe `app.ts`s
 * `userProvider`-Closure — Draft-, Lock-, Workflow-, Create-Page- und
 * Templates-Routen zeigen alle auf dieselbe Funktion hier) an eine
 * `GitProvider`-Instanz kommen. Statt jede der ~20 Provider-Methode an jeder
 * Aufrufstelle einzeln mit Refresh-Logik zu umwickeln, liefert `getUserProvider`
 * eine mit `withTokenRefresh` ummantelte Instanz zurück: jeder Methodenaufruf
 * löst bei einem 401 genau einen Refresh + Retry aus (`auth/token-refresh.ts`).
 * Der Proxy-`target` ist eine ECHTE, mit dem aktuellen Token gebaute Instanz
 * (nicht nur ein leeres Objekt), damit `instanceof ForgejoProvider`/
 * `GitHubProvider` an Aufrufstellen (siehe `drafts-user-provider.test.ts`)
 * weiterhin funktioniert — `instanceof` prüft die Prototypenkette des
 * `target`, NICHT den `get`-Trap.
 */
export interface UserProviderDeps {
  db: Db
  /** Schlüssel zur Entschlüsselung des Provider-Tokens (F451_TOKEN_KEY). */
  tokenKey: string
  /** Forgejo-Basis-URL aus der Registry-Konfiguration (`spaces/config.ts`,
   *  `getForgejoBaseUrl`). Fehlt sie, können Forgejo-Nutzer-Provider nicht
   *  gebaut werden (null statt Instanz — analog zu `canReadSpace` ohne
   *  Basis-URL: fail-closed statt Absturz). */
  forgejoBaseUrl?: string
  /** OAuth-Client-Konfiguration für den Token-Refresh (Task 4b/4) — dieselbe
   *  Quelle wie bei der Kontoverknüpfung (`opts.auth.connect`, `app.ts`). Ohne
   *  sie (oder ohne den jeweiligen Provider darin) bleibt Refresh unmöglich;
   *  `withTokenRefresh` degradiert dann bei einem 401 zum Propagieren des
   *  ursprünglichen Fehlers statt eines Retries — kein Absturz. */
  connect?: ConnectOptions
}

function buildRawProvider(deps: UserProviderDeps, space: SpaceConfig, accessToken: string): GitProvider | null {
  if (space.provider === 'github') {
    return new GitHubProvider({ token: accessToken })
  }
  if (!deps.forgejoBaseUrl) return null
  return new ForgejoProvider({ baseUrl: deps.forgejoBaseUrl, token: accessToken })
}

/**
 * Liefert eine `GitProvider`-Instanz mit dem Token des angemeldeten Nutzers
 * für den gegebenen Space, oder `null`, wenn der Nutzer kein verknüpftes
 * Konto für den Provider des Space hat (Aufrufer mappt das auf 403 mit
 * „Konto verknüpfen"-Hinweis, Plan Global Constraints — kein 404, die Seite
 * ist ja lesend sichtbar). Jede Methode der zurückgegebenen Instanz löst bei
 * einem 401 genau einen Token-Refresh + Retry aus (Task 4b/4, s. o.).
 */
export async function getUserProvider(
  deps: UserProviderDeps,
  userId: string,
  space: SpaceConfig,
): Promise<GitProvider | null> {
  const stored = await getUserProviderTokens(deps.db, userId, space.provider, deps.tokenKey)
  if (!stored) return null

  const initial = buildRawProvider(deps, space, stored.accessToken)
  if (!initial) return null

  const refreshDeps: TokenRefreshDeps = { db: deps.db, tokenKey: deps.tokenKey, connect: deps.connect ?? {} }

  return new Proxy(initial, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value

      return (...args: unknown[]) =>
        withTokenRefresh(refreshDeps, userId, space.provider, async (accessToken) => {
          const raw = buildRawProvider(deps, space, accessToken) as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >
          return raw[prop as string]!(...args)
        })
    },
  })
}
