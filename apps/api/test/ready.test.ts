import { describe, expect, it } from 'vitest'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { buildApp } from '../src/app.js'

describe('GET /readyz', () => {
  it('antwortet 503, wenn keine Datenbank konfiguriert ist', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      status: 'unavailable',
      reason: 'keine Datenbank konfiguriert',
    })
    await app.close()
  })

  it('antwortet 200 bei erreichbarer Datenbank', async () => {
    const container = await new PostgreSqlContainer('postgres:17-alpine').start()
    const app = buildApp({ databaseUrl: container.getConnectionUri() })
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
    await container.stop()
  }, 120_000)

  it('antwortet 503, wenn die Datenbank konfiguriert, aber nicht erreichbar ist', async () => {
    const app = buildApp({ databaseUrl: 'postgres://user:pass@127.0.0.1:59999/nope' })
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      status: 'unavailable',
      reason: 'Datenbank nicht erreichbar',
    })
    await app.close()
  }, 30_000)
})
