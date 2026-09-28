import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

describe('GET /api/openapi.json', () => {
  it('liefert eine OpenAPI-3-Spec mit den Health-Routen', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json()
    expect(spec.openapi).toMatch(/^3\./)
    expect(spec.info.title).toBe('f451 API')
    expect(spec.paths['/healthz']).toBeDefined()
    expect(spec.paths['/readyz']).toBeDefined()
    await app.close()
  })

  it('enthält /admin/reindex (Tag admin), sobald Spaces+Provider-Registry konfiguriert sind', async () => {
    // Kein echter Verbindungsaufbau nötig — pg.Pool verbindet erst bei der ersten
    // Query, und diese Route wird nie aufgerufen. Reicht, um die Sub-Plugin-
    // Registrierung (Task-7-Fix: admin.ts jetzt wie pages/search) zu verifizieren,
    // ohne Testcontainer zu starten.
    const app = buildApp({
      databaseUrl: 'postgres://user:pass@localhost:1/db-not-used',
      spaces: [],
      providerRegistry: () => {
        throw new Error('wird in diesem Test nicht aufgerufen')
      },
    })
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json()
    expect(spec.paths['/admin/reindex']).toBeDefined()
    expect(spec.paths['/admin/reindex'].post.tags).toContain('admin')
    await app.close()
  })

  it('enthält /api/pages/{id}/draft (Tag drafts, Phase 2a Task 2), sobald Auth+Spaces+Provider-Registry konfiguriert sind', async () => {
    // Wie beim admin-Test: kein echter Verbindungsaufbau nötig, die Route wird
    // nie aufgerufen — reicht, um die Sub-Plugin-Registrierung von
    // `registerDraftsRoutes` (nur aktiv bei `opts.auth`, siehe app.ts) in der
    // generierten OpenAPI-Spec zu verifizieren.
    const app = buildApp({
      databaseUrl: 'postgres://user:pass@localhost:1/db-not-used',
      spaces: [],
      providerRegistry: () => {
        throw new Error('wird in diesem Test nicht aufgerufen')
      },
      auth: { tokenKey: Buffer.alloc(32, 1).toString('base64') },
    })
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json()
    const path = spec.paths['/api/pages/{id}/draft']
    expect(path).toBeDefined()
    expect(path.post.tags).toContain('drafts')
    expect(path.get.tags).toContain('drafts')
    expect(path.put.tags).toContain('drafts')
    expect(path.delete.tags).toContain('drafts')
    await app.close()
  })

  it('enthält /api/locks/{pageId} (Tag locks, Phase 2a Task 4), sobald Auth+Spaces+Provider-Registry konfiguriert sind', async () => {
    const app = buildApp({
      databaseUrl: 'postgres://user:pass@localhost:1/db-not-used',
      spaces: [],
      providerRegistry: () => {
        throw new Error('wird in diesem Test nicht aufgerufen')
      },
      auth: { tokenKey: Buffer.alloc(32, 1).toString('base64') },
    })
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json()
    const path = spec.paths['/api/locks/{pageId}']
    expect(path).toBeDefined()
    expect(path.put.tags).toContain('locks')
    expect(path.delete.tags).toContain('locks')
    await app.close()
  })
})
