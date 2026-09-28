import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createDb, type Db } from '../src/db/client.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startMockIdp, type MockIdp } from './helpers/mock-idp.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Rate-Limits (Task 4a-2, Spec §7): Auth-Routen und Suche bekommen ein knappes
 * Anfragebudget pro Zeitfenster, alle anderen Routen bleiben unlimitiert.
 * `AppOptions.rateLimits` erlaubt hier absichtlich knappe Testwerte — der
 * Produktions-Default (`{ auth: {max:10,...}, search: {max:60,...} }`) ist
 * hoch genug, dass Bestandstests nicht ins Limit laufen (siehe app.ts).
 *
 * Drei getrennte App-Instanzen auf derselben DB: `authApp` mit knappem
 * Auth-Limit (OIDC/Mock-IdP nötig, damit `/auth/login` überhaupt registriert
 * wird), `searchApp` mit knappem Such-Limit (ohne Auth — die Suche ist
 * ohne `opts.auth` offen, 1c-Verhalten, spart den Login-Umweg) und
 * `proxyApp` (wie `searchApp`, zusätzlich `trustProxy: 1` — Fix-Runde 1,
 * Review-Finding 1: hinter dem Reverse Proxy aus Spec §8 wäre `req.ip` sonst
 * für ALLE Nutzer dieselbe Proxy-IP → ein geteilter Zähler pro Route,
 * 10 fremde Login-Versuche/min sperren den Login firmenweit). Getrennte
 * Instanzen zeigen zugleich, dass Auth- und Such-Budget NICHT geteilt sind
 * (jede Route hat ihren eigenen Zähler, kein gemeinsamer Store).
 */
describe.sequential('Rate-Limits (Spec §7: Auth, Suche)', () => {
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let idp: MockIdp
  let authApp: FastifyInstance
  let searchApp: FastifyInstance
  let proxyApp: FastifyInstance

  /** Feste Adresse, mit der der (einzige, vertraute) Reverse Proxy bei uns
   *  ankommt — bei `trustProxy: 1` ist genau dieser letzte Hop vertraut. */
  const PROXY_ADDR = '172.18.0.2'

  const TOKEN_KEY = Buffer.alloc(32, 42).toString('base64')
  const REDIRECT_URL = 'http://localhost:9999/auth/callback'

  const space: SpaceConfig = {
    id: 'rl-space',
    name: 'Rate-Limit Stub Space',
    provider: 'forgejo',
    owner: 'stub-owner',
    repo: 'stub-repo',
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'stub-owner', repo: 'stub-repo' },
  }

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    idp = await startMockIdp()

    authApp = buildApp({
      databaseUrl: pg.connectionString,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        // Task 3 (Auth-Härtung M2, Spec §7): seit der Entkopplung von
        // `insecureCookies` steuert ausschließlich dieses Feld, ob die
        // OIDC-Discovery http-Issuer erlaubt (hier: der Mock-IdP).
        oidcAllowInsecure: true,
        oidc: {
          issuer: idp.issuer,
          clientId: 'test-client',
          clientSecret: 'test-secret',
          redirectUrl: REDIRECT_URL,
        },
      },
      rateLimits: { auth: { max: 2, windowMs: 60_000 }, search: { max: 60, windowMs: 60_000 } },
    })
    await authApp.ready()

    searchApp = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => {
        throw new Error('providerRegistry: im Test nicht erwartet')
      },
      rateLimits: { auth: { max: 60, windowMs: 60_000 }, search: { max: 2, windowMs: 60_000 } },
    })
    await searchApp.ready()

    proxyApp = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => {
        throw new Error('providerRegistry: im Test nicht erwartet')
      },
      rateLimits: { auth: { max: 60, windowMs: 60_000 }, search: { max: 2, windowMs: 60_000 } },
      // Genau EIN vertrauter Hop (der eigene Reverse Proxy, Spec §8) — NICHT
      // `true`: damit nähme proxy-addr das LINKESTE X-Forwarded-For-Glied,
      // das der Client selbst setzen (und pro Request variieren) kann.
      trustProxy: 1,
    })
    await proxyApp.ready()
  }, 120_000)

  afterAll(async () => {
    await authApp?.close()
    await searchApp?.close()
    await proxyApp?.close()
    await idp?.stop()
    await handle?.close()
    await pg?.stop()
  })

  it('Auth: 3. Login-Versuch im Fenster → 429 {status:"rate_limited"}', async () => {
    await authApp.inject({ method: 'GET', url: '/auth/login', remoteAddress: '10.0.0.1' })
    await authApp.inject({ method: 'GET', url: '/auth/login', remoteAddress: '10.0.0.1' })
    const res = await authApp.inject({ method: 'GET', url: '/auth/login', remoteAddress: '10.0.0.1' })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ status: 'rate_limited' })
  })

  it('Suche: über dem Limit → 429; unterhalb unverändert', async () => {
    const r1 = await searchApp.inject({ method: 'GET', url: '/api/search?q=x', remoteAddress: '10.0.1.1' })
    const r2 = await searchApp.inject({ method: 'GET', url: '/api/search?q=x', remoteAddress: '10.0.1.1' })
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)

    const r3 = await searchApp.inject({ method: 'GET', url: '/api/search?q=x', remoteAddress: '10.0.1.1' })
    expect(r3.statusCode).toBe(429)
    expect(r3.json()).toMatchObject({ status: 'rate_limited' })
  })

  it('ungelimitete Route bleibt ungelimitet (GET /api/pages/:id 3x hintereinander)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await searchApp.inject({ method: 'GET', url: '/api/pages/unbekannt', remoteAddress: '10.0.2.1' })
      expect(res.statusCode).toBe(404)
    }
  })

  it('verschiedene IPs zählen getrennt', async () => {
    // IP A schöpft ihr Such-Limit (2) komplett aus.
    await searchApp.inject({ method: 'GET', url: '/api/search?q=y', remoteAddress: '10.0.3.1' })
    await searchApp.inject({ method: 'GET', url: '/api/search?q=y', remoteAddress: '10.0.3.1' })
    const blocked = await searchApp.inject({ method: 'GET', url: '/api/search?q=y', remoteAddress: '10.0.3.1' })
    expect(blocked.statusCode).toBe(429)

    // IP B ist unabhängig davon noch frei — eigener Zähler pro Client-IP.
    const free = await searchApp.inject({ method: 'GET', url: '/api/search?q=y', remoteAddress: '10.0.3.2' })
    expect(free.statusCode).toBe(200)
  })

  // Fix-Runde 1, Review-Finding 1 (HIGH): hinter dem Reverse Proxy (Spec §8)
  // kommen ALLE Requests mit derselben remoteAddress (der Proxy-IP) an — ohne
  // trustProxy zählte der Limiter alle Nutzer in EINEM Zähler pro Route
  // (firmenweiter Login-Lockout durch 10 fremde Versuche/min). Mit
  // `trustProxy: 1` ist genau der letzte Hop vertraut, `req.ip` wird das
  // LETZTE X-Forwarded-For-Glied — das ist das vom vertrauten Proxy selbst
  // angehängte, nicht spoofbare (proxy-addr läuft die Kette von rechts, ab
  // dem ersten unvertrauten Glied ist Schluss).
  describe('trustProxy: 1 (hinter Reverse Proxy, Spec §8)', () => {
    it('zwei Client-IPs via X-Forwarded-For (gleiche Proxy-remoteAddress) zählen GETRENNT', async () => {
      const injectAs = (clientIp: string) =>
        proxyApp.inject({
          method: 'GET',
          url: '/api/search?q=p',
          remoteAddress: PROXY_ADDR,
          headers: { 'x-forwarded-for': clientIp },
        })

      // Client A schöpft sein Limit (2) aus …
      expect((await injectAs('198.51.100.1')).statusCode).toBe(200)
      expect((await injectAs('198.51.100.1')).statusCode).toBe(200)
      const blocked = await injectAs('198.51.100.1')
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json()).toMatchObject({ status: 'rate_limited' })

      // … Client B hinter DEMSELBEN Proxy bleibt frei (kein geteilter Zähler,
      // der Lockout-Fall aus dem Review-Finding ist behoben).
      const free = await injectAs('198.51.100.2')
      expect(free.statusCode).toBe(200)
    })

    it('Spoofing-Härte: selbst gesetzte zusätzliche XFF-Einträge umgehen das Limit NICHT (es zählt das letzte, vom vertrauten Hop stammende Glied)', async () => {
      // Der Angreifer (echte IP 198.51.100.7) schickt pro Request ein ANDERES
      // erfundenes XFF-Präfix mit. Der echte Proxy hängt die von IHM gesehene
      // Client-IP hinten an — beim Server kommt also `<spoofed…>, 198.51.100.7`
      // an. Mit trustProxy:1 ist nur der letzte Hop (Proxy) vertraut →
      // proxy-addr nimmt das LETZTE Glied (198.51.100.7) als req.ip; die
      // variierenden Präfixe sind wirkungslos.
      const injectSpoofed = (spoofedPrefix: string) =>
        proxyApp.inject({
          method: 'GET',
          url: '/api/search?q=s',
          remoteAddress: PROXY_ADDR,
          headers: { 'x-forwarded-for': `${spoofedPrefix}, 198.51.100.7` },
        })

      expect((await injectSpoofed('6.6.6.6')).statusCode).toBe(200)
      expect((await injectSpoofed('9.9.9.9')).statusCode).toBe(200)
      const blocked = await injectSpoofed('1.2.3.4')
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json()).toMatchObject({ status: 'rate_limited' })
    })
  })

  it('ohne trustProxy bleibt heutiges Verhalten: X-Forwarded-For wird ignoriert, es zählt die remoteAddress (Regressionsfall)', async () => {
    // Ohne trustProxy darf ein Client sich NICHT per XFF-Header als jemand
    // anderes ausgeben — alle drei Requests derselben remoteAddress teilen
    // den Zähler, egal was im Header steht.
    const injectWithXff = (xff: string) =>
      searchApp.inject({
        method: 'GET',
        url: '/api/search?q=r',
        remoteAddress: '10.0.4.1',
        headers: { 'x-forwarded-for': xff },
      })

    expect((await injectWithXff('198.51.100.10')).statusCode).toBe(200)
    expect((await injectWithXff('198.51.100.11')).statusCode).toBe(200)
    const blocked = await injectWithXff('198.51.100.12')
    expect(blocked.statusCode).toBe(429)
  })
})
