import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

/**
 * Task 5 (Betrieb, Spec §7): Pino-`redact` in `buildApp` — die drei Pfade
 * `req.headers.authorization`, `req.headers.cookie`,
 * `req.headers["x-hub-signature-256"]` decken die einzigen Stellen ab, an
 * denen Klartext-Geheimnisse in einem Request dieser API stehen (Admin-
 * Bearer-Token, Session-Cookie, GitHub-Webhook-HMAC).
 *
 * WICHTIG (Grund für den Test-Aufbau unten): Fastifys EINGEBAUTER `req`-
 * Serializer (der jede automatische "incoming request"/"request completed"-
 * Logzeile durchläuft) reduziert das Request-Objekt bereits VOR jeder
 * Redaction auf `{method,url,version,hostname,remoteAddress,remotePort}` —
 * Header tauchen dort schon by design nie auf (verifiziert: ein `app.inject()`
 * mit `Authorization`-Header erzeugt KEINE Logzeile, die `authorization`
 * überhaupt enthält, weder im Klartext noch redigiert). Die Redaction-Liste
 * ist daher Verteidigung in der Tiefe für JEDEN Log-Aufruf, der Header
 * abweichend vom Standard-Serializer mitschickt (z. B. künftiges Debug-
 * Logging oder ein geänderter `req`-Serializer) — dieser Test überschreibt
 * den `req`-Serializer für einen Kind-Logger gezielt auf Durchreichen
 * (Pino-Muster `logger.child(bindings, {serializers})`), um genau diesen
 * Fall zu erzwingen und die Redaction-Konfiguration selbst zu beweisen,
 * OHNE den globalen Serializer der App dauerhaft zu ändern.
 */
describe('Pino-Log-Redaction (Task 5, Betrieb)', () => {
  it(
    'req.headers.authorization/cookie/x-hub-signature-256 erscheinen als "[Redacted]" ' +
      'statt im Klartext, sobald ein Log-Aufruf sie mitschickt',
    async () => {
      const logChunks: string[] = []
      const logStream = new PassThrough()
      logStream.on('data', (chunk: Buffer) => logChunks.push(chunk.toString('utf8')))

      const app = buildApp({ logStream })

      const ADMIN_TOKEN = 'super-secret-admin-bearer-token'
      const SESSION_COOKIE = 'f451_session=super-secret-session-id'
      const WEBHOOK_SIGNATURE = 'sha256=super-secret-hmac-signature'

      const child = app.log.child({}, { serializers: { req: (r: unknown) => r } })
      child.info(
        {
          req: {
            headers: {
              authorization: `Bearer ${ADMIN_TOKEN}`,
              cookie: SESSION_COOKIE,
              'x-hub-signature-256': WEBHOOK_SIGNATURE,
              // Kontrollwert: NICHT in der Redact-Liste — muss im Klartext bleiben,
              // sonst würde der Test auch bei einer zu weiten (alles maskierenden)
              // Fehlkonfiguration grün bleiben.
              'user-agent': 'f451-redaction-test-agent',
            },
          },
        },
        'Test-Logzeile mit Request-Headern',
      )

      await new Promise((resolve) => setImmediate(resolve))
      await app.close()

      const logOutput = logChunks.join('')
      expect(logOutput.length).toBeGreaterThan(0) // Kanary: Logger schreibt überhaupt etwas.
      expect(logOutput).not.toContain(ADMIN_TOKEN)
      expect(logOutput).not.toContain(SESSION_COOKIE)
      expect(logOutput).not.toContain(WEBHOOK_SIGNATURE)

      const parsed = JSON.parse(logOutput.trim().split('\n').pop()!) as {
        req: { headers: Record<string, string> }
      }
      expect(parsed.req.headers.authorization).toBe('[Redacted]')
      expect(parsed.req.headers.cookie).toBe('[Redacted]')
      expect(parsed.req.headers['x-hub-signature-256']).toBe('[Redacted]')
      // Kontrollwert bleibt unangetastet — die Redaction ist gezielt, nicht pauschal.
      expect(parsed.req.headers['user-agent']).toBe('f451-redaction-test-agent')
    },
  )

  it(
    'reguläre Anfragen (Fastifys eingebauter req-Serializer) loggen ohnehin keine Header im Klartext — ' +
      'Regressionsnachweis für die Begründung oben, unabhängig von der Redact-Konfiguration',
    async () => {
      const logChunks: string[] = []
      const logStream = new PassThrough()
      logStream.on('data', (chunk: Buffer) => logChunks.push(chunk.toString('utf8')))

      const app = buildApp({ logStream })
      const secretToken = 'plain-request-secret-token-should-never-appear'
      await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { authorization: `Bearer ${secretToken}` },
      })

      await new Promise((resolve) => setImmediate(resolve))
      await app.close()

      const logOutput = logChunks.join('')
      expect(logOutput.length).toBeGreaterThan(0)
      expect(logOutput).not.toContain(secretToken)
    },
  )
})
