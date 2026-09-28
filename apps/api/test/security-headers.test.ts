import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

/**
 * Task 4 (Security & Betrieb, Spec §7): globale Security-Header (X-Content-
 * Type-Options, Referrer-Policy) auf JEDER API-Antwort — per `onSend`-Hook in
 * `app.ts`, NICHT über einen einzelnen Route-Handler, damit auch Fehler-
 * Antworten (404/500/Framework-Fehler) sie tragen. Der Hook setzt NUR, wenn
 * der Header noch nicht vorhanden ist — die Media-Route (`routes/media.ts`)
 * setzt ihre eigene, sandboxte `Content-Security-Policy` UND ihr eigenes
 * `X-Content-Type-Options`; beide dürfen der Hook nicht überschreiben (dessen
 * Regression deckt `media.test.ts` ab).
 */
describe('globale Security-Header (Task 4, onSend-Hook)', () => {
  it('GET /healthz trägt X-Content-Type-Options: nosniff und Referrer-Policy: no-referrer', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    await app.close()
  })

  it('auch eine 404-Antwort (unbekannte Route) trägt beide Header', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/gibt-es-nicht' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    await app.close()
  })
})
