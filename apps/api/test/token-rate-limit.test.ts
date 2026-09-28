import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createSession, SESSION_COOKIE_NAME } from '../src/auth/sessions.js'
import { createTokenRateLimiter } from '../src/auth/token-rate-limit.js'
import { createDb, type Db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/** Issue #73: Budget für API-Token-Aufrufe, pro Nutzer statt pro IP. */

describe('createTokenRateLimiter', () => {
  it('lässt max Anfragen je Fenster durch und nennt danach die Restwartezeit', () => {
    let t = 0
    const limit = createTokenRateLimiter({ max: 2, windowMs: 60_000 }, () => t)

    expect(limit('u1')).toEqual({ allowed: true })
    expect(limit('u1')).toEqual({ allowed: true })
    t = 20_000
    expect(limit('u1')).toEqual({ allowed: false, retryAfterSec: 40 })
  })

  it('zählt Schlüssel getrennt und beginnt nach Fensterende neu', () => {
    let t = 0
    const limit = createTokenRateLimiter({ max: 1, windowMs: 1_000 }, () => t)

    expect(limit('u1').allowed).toBe(true)
    expect(limit('u2').allowed).toBe(true)
    expect(limit('u1').allowed).toBe(false)
    t = 1_000
    expect(limit('u1').allowed).toBe(true)
  })
})

describe.sequential('API-Token-Budget im Auth-Hook', () => {
  const TOKEN_KEY = Buffer.alloc(32, 21).toString('base64')
  const BUDGET = 3
  let pg: PgTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let app: FastifyInstance
  let userCounter = 0

  beforeAll(async () => {
    pg = await startPg()
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    app = buildApp({
      databaseUrl: pg.connectionString,
      auth: { tokenKey: TOKEN_KEY, insecureCookies: true },
      rateLimits: {
        auth: { max: 1000, windowMs: 60_000 },
        search: { max: 1000, windowMs: 60_000 },
        apiToken: { max: BUDGET, windowMs: 60_000 },
      },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await pg?.stop()
  })

  async function sessionFor(): Promise<string> {
    userCounter += 1
    const userId = `rl-user-${userCounter}`
    await db.insert(users).values({ id: userId, email: `${userId}@example.org`, displayName: userId })
    return (await createSession(db, userId)).id
  }

  async function mintToken(cookie: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: { label: 'rl', scope: 'read' },
    })
    expect(res.statusCode).toBe(200)
    return (res.json() as { token: string }).token
  }

  const meWithToken = (token: string) =>
    app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } })

  it('sperrt nach dem Budget mit 429 und Retry-After — über alle Tokens eines Nutzers', async () => {
    const cookie = await sessionFor()
    const first = await mintToken(cookie)
    const second = await mintToken(cookie)

    for (let i = 0; i < BUDGET - 1; i++) expect((await meWithToken(first)).statusCode).toBe(200)
    expect((await meWithToken(second)).statusCode).toBe(200)

    const blocked = await meWithToken(second)
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(blocked.json()).toEqual({ status: 'rate_limited', reason: 'Zu viele Anfragen — bitte kurz warten.' })

    // Die Browser-Session desselben Nutzers bleibt unberührt.
    const viaSession = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: cookie } })
    expect(viaSession.statusCode).toBe(200)
  })

  it('ein anderer Nutzer hat sein eigenes Budget', async () => {
    const token = await mintToken(await sessionFor())
    expect((await meWithToken(token)).statusCode).toBe(200)
  })
})
