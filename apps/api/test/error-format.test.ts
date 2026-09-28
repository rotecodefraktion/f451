import { beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

// Die dokumentierte 500-Klasse (Ledger 3b/3e): Fastify-eigene Fehlerbodies
// kollidieren mit dem deklarierten {status,reason}-errorSchema →
// FST_ERR_FAILED_ERROR_SERIALIZATION → 500. Der zentrale Error-Handler
// übersetzt sie VOR der Serialisierung ins Projektformat.
describe('zentraler Error-Formatter', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildApp()

    // Test-Route mit dem projektüblichen Schema-Muster: Body mit required,
    // Response 400 = errorSchema — exakt die Kollisionskonstellation.
    await app.register(async (instance) => {
      instance.post(
        '/test/schema',
        {
          schema: {
            body: {
              type: 'object',
              properties: { title: { type: 'string' } },
              required: ['title'],
            },
            response: { 200: { type: 'object' }, 400: errorSchema, 413: errorSchema },
          },
        },
        async () => ({ ok: true }),
      )

      instance.get('/test/boom', async () => {
        throw new Error('geheime-details: interner Zustand')
      })

      // Fix-Runde 1, FIX 2: simuliert exakt das Verhalten von @fastify/rate-
      // limit mit custom errorResponseBuilder — das Plugin wirft das vom
      // Builder zurückgegebene Objekt UNVERÄNDERT (kein Error-Instance, KEIN
      // `.message`-Feld), nur `statusCode`/`status`/`reason`.
      instance.get('/test/rate-limited', async () => {
        throw { statusCode: 429, status: 'rate_limited', reason: 'Zu viele Anfragen aus diesem Netz.' }
      })

      // Fix-Runde 2: parametrische Route — nötig, damit find-my-way beim
      // Lookup die maxParamLength-Prüfung (Default 100) überhaupt erreicht
      // (FST_ERR_MAX_PARAM_LENGTH läuft über frameworkErrors, wie /%zz).
      instance.get('/test/param/:id', async () => ({ ok: true }))
    })

    await app.ready()
  })

  it('AJV-Fehler (fehlendes Pflichtfeld) → 400 {status:"bad_request"}, nie 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/schema', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
  })

  it('malformed JSON → 400 {status,reason}, nie 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/schema',
      headers: { 'content-type': 'application/json' },
      payload: '{"kaputt": ',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
  })

  it('leerer Body mit Content-Type application/json → 400, nie 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/schema',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad_request' })
  })

  it('Body über bodyLimit → 413 {status:"payload_too_large"}, nie 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/schema',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) }),
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ status: 'payload_too_large' })
  })

  it('unerwarteter Handler-Throw → 500 {status:"error"} OHNE err.message-Leak', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ status: 'error', reason: 'Interner Fehler.' })
    expect(res.body).not.toContain('geheime-details')
  })

  // Fix-Runde 1, FIX 1 (Adjudikation): der semantische Statuscode eines 4xx-
  // Fehlers bleibt erhalten — ein Content-Type-Fehler (FST_ERR_CTP_INVALID_
  // MEDIA_TYPE) hat nativ 415, KEIN Zwang auf 400. Nur der Body wird
  // normalisiert. Die Test-Route deklariert kein 415 im response-Schema —
  // genau das ist die Voraussetzung dafür, dass die Serialisierung nicht
  // erneut FST_ERR_FAILED_ERROR_SERIALIZATION wirft.
  it('ungültiger Content-Type (application/xml) → 415 {status,reason}, nie 500, kein Fastify-Altformat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/schema',
      headers: { 'content-type': 'application/xml' },
      payload: '<x/>',
    })
    expect(res.statusCode).toBe(415)
    const body = res.json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'bad_request' })
    expect(typeof body.reason).toBe('string')
    expect(body).not.toHaveProperty('error')
    expect(body).not.toHaveProperty('message')
  })

  // Fix-Runde 1, FIX 2 (Critical für Task 2): @fastify/rate-limit wirft bei
  // custom errorResponseBuilder dessen Rückgabeobjekt unverändert — kein
  // `.message`-Feld. Vor dem Fix hätte `err.message` (undefined) die
  // errorSchema-Pflicht `reason:string` verletzt → 500 statt 429.
  it('429 ohne err.message-Feld → 429 {status:"rate_limited", reason:<string>}, nie 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/rate-limited' })
    expect(res.statusCode).toBe(429)
    const body = res.json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'rate_limited' })
    expect(typeof body.reason).toBe('string')
    expect((body.reason as string).length).toBeGreaterThan(0)
  })

  // Fix-Runde 1, FIX 3: unbekannte Route läuft NICHT über setErrorHandler
  // (kein geworfener Fehler) — eigener setNotFoundHandler bringt sie auf das
  // projektweite Format.
  it('unbekannte Route → 404 {status:"not_found", reason:"Unbekannte Route."}', async () => {
    const res = await app.inject({ method: 'GET', url: '/gibt/es/nicht' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ status: 'not_found', reason: 'Unbekannte Route.' })
  })

  // Fix-Runde 1, FIX 3: kaputtes Percent-Encoding (FST_ERR_BAD_URL) wird
  // von Fastify VOR dem Routing geworfen — nur `frameworkErrors` kann hier
  // noch eingreifen, sonst antwortet Fastify mit seinem Alt-Format.
  it('kaputte URL (%zz) → 400 {status:"bad_request", reason:"Ungültige URL."}, kein Fastify-Altformat', async () => {
    const res = await app.inject({ method: 'GET', url: '/%zz' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ status: 'bad_request', reason: 'Ungültige URL.' })
  })

  // Fix-Runde 2: FST_ERR_MAX_PARAM_LENGTH (Pfadparameter > maxParamLength,
  // Default 100) läuft ebenfalls über frameworkErrors und hat nativ 414 — der
  // semantische Statuscode bleibt erhalten (adjudizierte Regel aus Fix-Runde 1:
  // kein Zwang auf 400), nur der Body wird normalisiert.
  it('Pfadparameter über maxParamLength (150 Zeichen) → 414 {status:"bad_request", reason:<string>}, nie 400/500', async () => {
    const res = await app.inject({ method: 'GET', url: `/test/param/${'x'.repeat(150)}` })
    expect(res.statusCode).toBe(414)
    const body = res.json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'bad_request' })
    expect(typeof body.reason).toBe('string')
    expect(body).not.toHaveProperty('error')
    expect(body).not.toHaveProperty('message')
  })

  // Self-Review-Auflage: setNotFoundHandler darf registrierte Routen (Swagger-
  // UI/OpenAPI-Spec) nicht schlucken.
  it('GET /api/openapi.json bleibt erreichbar (nicht vom NotFound-Handler geschluckt)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
  })

  it('GET /api/docs (Swagger-UI) bleibt erreichbar (nicht vom NotFound-Handler geschluckt)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs' })
    expect(res.statusCode).not.toBe(404)
  })
})
