import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

describe('GET /healthz', () => {
  it('antwortet 200 mit { status: "ok" }', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
  })
})
