import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { ProviderError } from '@f451/git-provider'
import { decryptToken } from '../src/auth/crypto.js'
import { upsertProviderAccount, type ConnectOptions } from '../src/auth/connect.js'
import {
  TokenRefreshError,
  refreshProviderToken,
  withTokenRefresh,
  type TokenRefreshDeps,
} from '../src/auth/token-refresh.js'
import { canReadSpace, clearPermissionCache, type FetchFn, type PermissionDeps } from '../src/auth/permissions.js'
import { createDb, type Db } from '../src/db/client.js'
import { providerAccounts, users } from '../src/db/schema.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'
import { startMockForgejoOAuth, type MockForgejoOAuth } from './helpers/mock-forgejo-oauth.js'

/**
 * Provider-Token-Refresh (Task 4b/4, Spec §9): `refreshProviderToken` +
 * `withTokenRefresh` gegen den echten Mock-Forgejo-OAuth-Server
 * (`helpers/mock-forgejo-oauth.ts`, jetzt mit `grant_type=refresh_token`,
 * rotierendem Refresh-Token). Testfälle a-e aus dem Task-Brief.
 */
describe.sequential('Provider-Token-Refresh (Task 4b/4)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let forgejo: MockForgejoOAuth
  let connect: ConnectOptions
  let userCounter = 0

  const TOKEN_KEY = Buffer.alloc(32, 13).toString('base64')
  const FORGEJO_CLIENT_ID = 'test-forgejo-client'
  const FORGEJO_CLIENT_SECRET = 'test-forgejo-secret'

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    forgejo = await startMockForgejoOAuth()
    connect = {
      forgejo: { baseUrl: forgejo.baseUrl, clientId: FORGEJO_CLIENT_ID, clientSecret: FORGEJO_CLIENT_SECRET },
      github: { clientId: 'test-github-client', clientSecret: 'test-github-secret' },
    }
  }, 120_000)

  afterAll(async () => {
    await forgejo.stop()
    await handle.close()
    await pg.stop()
  })

  afterEach(() => {
    forgejo.accessToken = 'forgejo-access-token-1'
    forgejo.refreshToken = 'forgejo-refresh-token-1'
    forgejo.login = 'alice-forgejo'
  })

  async function insertUser(): Promise<string> {
    userCounter += 1
    const userId = `refresh-user-${userCounter}`
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.org`,
      displayName: `Refresh User ${userCounter}`,
    })
    return userId
  }

  async function readRow(userId: string) {
    const rows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.userId, userId))
    return rows[0]
  }

  function makeDeps(overrides: Partial<TokenRefreshDeps> = {}): TokenRefreshDeps {
    return { db, tokenKey: TOKEN_KEY, connect, ...overrides }
  }

  /** `fn`-Stub: wirft beim ersten Aufruf einen 401-`ProviderError`, liefert ab
   *  dem zweiten Aufruf erfolgreich das übergebene Access-Token zurück. */
  function makeFailOnceFn() {
    let calls = 0
    return vi.fn(async (accessToken: string) => {
      calls += 1
      if (calls === 1) throw new ProviderError('nicht autorisiert', 401, '')
      return accessToken
    })
  }

  /** `fn`-Stub für den Konkurrenz-Testfall (e): wirft 401 nur, solange das
   *  übergebene Access-Token noch der ANFÄNGLICHE (abgelaufene) Token ist —
   *  nicht nach Aufrufanzahl gestaffelt wie {@link makeFailOnceFn}. Wichtig für
   *  Testfall (e): der zweite parallele Aufruf liest seinen Access-Token
   *  möglicherweise erst NACH dem Refresh des ersten aus der DB (echtes
   *  Zeitfenster, kein deterministisches Interleaving) — mit einem
   *  aufrufzahl-basierten Stub würde dieser zweite Aufruf fälschlich (und
   *  unabhängig vom tatsächlichen Token) einen zweiten, unnötigen Refresh
   *  auslösen. Token-basiert bildet ab, was der echte Provider täte: ein
   *  gültiges (bereits erneuertes) Token wird akzeptiert, das veraltete nicht. */
  function makeFailOnStaleFn(staleToken: string) {
    return vi.fn(async (accessToken: string) => {
      if (accessToken === staleToken) throw new ProviderError('nicht autorisiert', 401, '')
      return accessToken
    })
  }

  describe('refreshProviderToken', () => {
    it('wirft TokenRefreshError ohne gespeicherten Refresh-Token', async () => {
      const userId = await insertUser()
      await upsertProviderAccount(db, userId, 'forgejo', 'alice-fj', { accessToken: 'only-access' }, TOKEN_KEY)

      await expect(refreshProviderToken(makeDeps(), userId, 'forgejo')).rejects.toBeInstanceOf(TokenRefreshError)
    })
  })

  describe('withTokenRefresh', () => {
    it('(a) 401 -> Refresh -> neuer Token -> Retry-Erfolg, neue Tokens verschlüsselt persistiert', async () => {
      const userId = await insertUser()
      await upsertProviderAccount(
        db,
        userId,
        'forgejo',
        'alice-fj',
        { accessToken: 'stale-access-token', refreshToken: forgejo.refreshToken },
        TOKEN_KEY,
      )

      const fn = makeFailOnceFn()
      const result = await withTokenRefresh(makeDeps(), userId, 'forgejo', fn)

      expect(fn).toHaveBeenCalledTimes(2)
      expect(fn).toHaveBeenNthCalledWith(1, 'stale-access-token')
      const newAccessToken = fn.mock.calls[1]![0]
      expect(newAccessToken).not.toBe('stale-access-token')
      expect(result).toBe(newAccessToken)

      const row = await readRow(userId)
      expect(row).toBeDefined()
      const persistedAccess = decryptToken(row!.encryptedAccessToken, TOKEN_KEY)
      const persistedRefresh = decryptToken(row!.encryptedRefreshToken!, TOKEN_KEY)
      expect(persistedAccess).toBe(newAccessToken)
      expect(persistedAccess).toBe(forgejo.accessToken)
      expect(persistedRefresh).toBe(forgejo.refreshToken)
      expect(persistedRefresh).not.toBe('forgejo-refresh-token-1')
      expect(row!.needsReconnect).toBe(false)
    })

    it('(b) Refresh abgelehnt (invalid_grant) -> ursprünglicher 401 propagiert, Tokens unverändert', async () => {
      const userId = await insertUser()
      const originalAccess = 'stale-access-token'
      const originalRefresh = 'ein-nie-vom-mock-akzeptierter-refresh-token'
      await upsertProviderAccount(
        db,
        userId,
        'forgejo',
        'alice-fj',
        { accessToken: originalAccess, refreshToken: originalRefresh },
        TOKEN_KEY,
      )

      const originalError = new ProviderError('nicht autorisiert', 401, '')
      const fn = vi.fn(async () => {
        throw originalError
      })

      await expect(withTokenRefresh(makeDeps(), userId, 'forgejo', fn)).rejects.toBe(originalError)
      expect(fn).toHaveBeenCalledTimes(1)

      const row = await readRow(userId)
      expect(decryptToken(row!.encryptedAccessToken, TOKEN_KEY)).toBe(originalAccess)
      expect(decryptToken(row!.encryptedRefreshToken!, TOKEN_KEY)).toBe(originalRefresh)
    })

    it('(b2) gescheiterter Refresh wird gewarnt — mit Grund, ohne Token (Issue #70)', async () => {
      const userId = await insertUser()
      const deadRefresh = 'ein-verbrauchter-refresh-token'
      await upsertProviderAccount(
        db,
        userId,
        'forgejo',
        'alice-fj',
        { accessToken: 'stale-access-token', refreshToken: deadRefresh },
        TOKEN_KEY,
      )
      const warn = vi.fn()

      await expect(
        withTokenRefresh(makeDeps({ log: { warn } }), userId, 'forgejo', async () => {
          throw new ProviderError('nicht autorisiert', 401, '')
        }),
      ).rejects.toBeInstanceOf(ProviderError)

      expect(warn).toHaveBeenCalledTimes(1)
      const [meta] = warn.mock.calls[0]!
      expect(meta).toMatchObject({ userId, provider: 'forgejo' })
      expect(meta.reason).toMatch(/forgejo-Token-Refresh abgelehnt \(Status 4\d\d/)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(deadRefresh)
      expect((await readRow(userId))!.needsReconnect).toBe(true)
    })

    it('(c) kein Refresh-Token gespeichert -> direkter Durchgriff ohne Refresh-Versuch', async () => {
      const userId = await insertUser()
      await upsertProviderAccount(db, userId, 'forgejo', 'alice-fj', { accessToken: 'only-access' }, TOKEN_KEY)

      let fetchCalls = 0
      const countingFetch: typeof fetch = async (...args) => {
        fetchCalls += 1
        return fetch(...args)
      }

      const originalError = new ProviderError('nicht autorisiert', 401, '')
      const fn = vi.fn(async () => {
        throw originalError
      })

      await expect(
        withTokenRefresh(makeDeps({ fetch: countingFetch }), userId, 'forgejo', fn),
      ).rejects.toBe(originalError)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fetchCalls).toBe(0)
    })

    it('(d) Nicht-401-Fehler -> kein Refresh-Versuch, fn genau einmal aufgerufen', async () => {
      const userId = await insertUser()
      await upsertProviderAccount(
        db,
        userId,
        'forgejo',
        'alice-fj',
        { accessToken: 'stale-access-token', refreshToken: forgejo.refreshToken },
        TOKEN_KEY,
      )

      let fetchCalls = 0
      const countingFetch: typeof fetch = async (...args) => {
        fetchCalls += 1
        return fetch(...args)
      }

      const notFoundError = new ProviderError('nicht gefunden', 404, '')
      const fn = vi.fn(async () => {
        throw notFoundError
      })

      await expect(
        withTokenRefresh(makeDeps({ fetch: countingFetch }), userId, 'forgejo', fn),
      ).rejects.toBe(notFoundError)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fetchCalls).toBe(0)

      const genericError = new Error('irgendein anderer Fehler')
      const fn2 = vi.fn(async () => {
        throw genericError
      })
      await expect(
        withTokenRefresh(makeDeps({ fetch: countingFetch }), userId, 'forgejo', fn2),
      ).rejects.toBe(genericError)
      expect(fn2).toHaveBeenCalledTimes(1)
      expect(fetchCalls).toBe(0)
    })

    it('(e) Concurrency: zwei parallele Aufrufe desselben Nutzers erzeugen kein Doppel-Refresh-Chaos', async () => {
      const userId = await insertUser()
      await upsertProviderAccount(
        db,
        userId,
        'forgejo',
        'alice-fj',
        { accessToken: 'stale-access-token', refreshToken: forgejo.refreshToken },
        TOKEN_KEY,
      )

      let refreshHttpCalls = 0
      const countingFetch: typeof fetch = async (...args) => {
        refreshHttpCalls += 1
        return fetch(...args)
      }
      const deps = makeDeps({ fetch: countingFetch })

      // Token-basierter Stub (nicht aufrufzahl-basiert wie `makeFailOnceFn`):
      // beide Aufrufe starten mit demselben abgelaufenen Token, aber der
      // zweite könnte seinen Access-Token je nach Timing bereits NACH dem
      // Refresh des ersten aus der DB lesen (siehe Kommentar bei
      // `makeFailOnStaleFn`) — dann darf er nicht künstlich scheitern.
      const fnA = makeFailOnStaleFn('stale-access-token')
      const fnB = makeFailOnStaleFn('stale-access-token')

      const [resultA, resultB] = await Promise.all([
        withTokenRefresh(deps, userId, 'forgejo', fnA),
        withTokenRefresh(deps, userId, 'forgejo', fnB),
      ])

      // In-Prozess-Mutex (Task-4b/4-Design, siehe `token-refresh.ts`): trotz
      // zweier paralleler 401-Retries löst nur EIN tatsächlicher Provider-
      // Aufruf den (bei Forgejo rotierenden) Refresh-Token ein — der zweite
      // Aufruf wartet auf dasselbe In-Flight-Promise, statt selbst einen
      // (inzwischen verbrauchten) Refresh-Versuch zu unternehmen.
      expect(refreshHttpCalls).toBe(1)

      // Beide Aufrufe erhalten am Ende ein gültiges, NICHT das veraltete Token
      // — unabhängig davon, ob sie es per Retry (nach 401) oder direkt (weil
      // ihr eigener DB-Read bereits das frische Token sah) bekamen.
      expect(resultA).not.toBe('stale-access-token')
      expect(resultB).not.toBe('stale-access-token')
      expect(resultA).toBe(resultB)

      const row = await readRow(userId)
      expect(decryptToken(row!.encryptedAccessToken, TOKEN_KEY)).toBe(resultA)
      // Genau EIN Refresh-Vorgang fand statt -> der gespeicherte Refresh-Token
      // wurde genau einmal rotiert (nicht zweimal, was bei einem Doppel-
      // Refresh zu einem WEITEREN, hier ungeprüften Wert geführt hätte).
      expect(decryptToken(row!.encryptedRefreshToken!, TOKEN_KEY)).toBe(forgejo.refreshToken)
    })

    it('degradiert für GitHub ohne gespeicherten Refresh-Token zu direktem fn (kein Verhaltensbruch)', async () => {
      const userId = await insertUser()
      await upsertProviderAccount(db, userId, 'github', 'octocat', { accessToken: 'gh-access-token' }, TOKEN_KEY)

      const fn = vi.fn(async (accessToken: string) => `ok:${accessToken}`)
      const result = await withTokenRefresh(makeDeps(), userId, 'github', fn)

      expect(result).toBe('ok:gh-access-token')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('wirft TokenRefreshError ohne verknüpftes Konto', async () => {
      const userId = await insertUser()
      const fn = vi.fn(async (accessToken: string) => accessToken)
      await expect(withTokenRefresh(makeDeps(), userId, 'forgejo', fn)).rejects.toBeInstanceOf(TokenRefreshError)
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('Permission-Probe nutzt Token-Refresh (Issue #25)', () => {
    // Bug: `probeSpace`/`probeSpaceWrite` (permissions.ts) riefen bislang roh
    // `fetch` auf und werteten nur `res.status === 200` — bei einem abgelaufenen
    // Access-Token (Provider antwortet 401) gab es KEINEN Refresh-Versuch,
    // obwohl ein gültiger Refresh-Token gespeichert war. Das negative Ergebnis
    // wurde dann 5 min als "nicht lesbar" gecacht. Dieser Test simuliert genau
    // das: `deps.fetch` (die Repo-Probe) liefert 401 für das gespeicherte
    // (abgelaufene) Access-Token, 200 für ein NEUES — der Token-Refresh selbst
    // läuft über den echten Mock-Forgejo-OAuth-Server (`forgejo`/`connect`,
    // gleiche Fixtures wie `withTokenRefresh` oben).
    const space: SpaceConfig = {
      id: 'perm-probe-space',
      name: 'Probe Space',
      provider: 'forgejo',
      owner: 'acme',
      repo: 'widgets',
      defaultLang: 'de',
      repoRef: { provider: 'forgejo', owner: 'acme', repo: 'widgets' },
    }

    afterEach(() => {
      clearPermissionCache()
    })

    it('401 mit gültigem Refresh-Token -> Refresh + Retry -> canReadSpace true, neuer Access-Token persistiert', async () => {
      const userId = await insertUser()
      const staleAccessToken = 'stale-probe-access-token'
      await upsertProviderAccount(
        db,
        userId,
        'forgejo',
        'alice-fj',
        { accessToken: staleAccessToken, refreshToken: forgejo.refreshToken },
        TOKEN_KEY,
      )

      let calls = 0
      const probeFetch: FetchFn = async (_url, init) => {
        calls += 1
        const auth = init?.headers?.Authorization
        if (auth === `Bearer ${staleAccessToken}`) {
          return { status: 401, json: async () => ({}) }
        }
        return { status: 200, json: async () => ({}) }
      }

      const deps: PermissionDeps = {
        db,
        tokenKey: TOKEN_KEY,
        forgejoBaseUrl: forgejo.baseUrl,
        connect,
        fetch: probeFetch,
      }

      expect(await canReadSpace(deps, userId, space)).toBe(true)
      expect(calls).toBe(2) // 1x mit dem abgelaufenen, 1x mit dem erneuerten Token

      const row = await readRow(userId)
      const persistedAccess = decryptToken(row!.encryptedAccessToken, TOKEN_KEY)
      expect(persistedAccess).not.toBe(staleAccessToken)
      expect(persistedAccess).toBe(forgejo.accessToken)

      // Das erneuerte (positive) Ergebnis darf gecacht sein -> kein weiterer Fetch.
      expect(await canReadSpace(deps, userId, space)).toBe(true)
      expect(calls).toBe(2)
    })
  })
})
