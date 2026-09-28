import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

/** Zentraler Error-Handler: übersetzt Fastify-/AJV-Fehler ins projektweite
 *  {status,reason}-Format, BEVOR die Response-Schema-Serialisierung greift.
 *  Hintergrund (Ledger 3b/3e): Fastifys eigene Fehlerbodies
 *  ({statusCode,error,message}) kollidieren mit dem in fast allen Routen
 *  deklarierten errorSchema (required: status,reason) →
 *  FST_ERR_FAILED_ERROR_SERIALIZATION → 500 statt 400/413/429.
 *
 *  WICHTIG: greift NUR bei geworfenen/Fastify-internen Fehlern (AJV, JSON-
 *  Parser, bodyLimit, …). Handler, die ihre Fehlerantwort selbst per
 *  `reply.code(...).send(...)` erzeugen (z. B. Webhook-Routen mit
 *  `{status:'ignored'}`, `providerErrorReply`-502-Pfade), laufen NIE durch
 *  diesen Handler — deren Verhalten bleibt unverändert. */
export function formatErrorReply(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  // AJV-Schemafehler (Body/Query/Params) — präzise Meldung ist hier gefahrlos,
  // sie beschreibt nur das Schema, keine internen Zustände.
  if (err.validation) {
    void reply.status(400).send({ status: 'bad_request', reason: err.message })
    return
  }
  const statusCode = err.statusCode ?? 500
  if (statusCode === 413) {
    void reply.status(413).send({ status: 'payload_too_large', reason: 'Request-Body zu groß.' })
    return
  }
  if (statusCode === 429) {
    // Rate-Limit (Task 2, @fastify/rate-limit mit custom errorResponseBuilder):
    // die Plugin-eigene errorResponseBuilder liefert ein PLAIN OBJECT
    // ({statusCode, status:'rate_limited', reason:'…'}) — Fastify wirft dieses
    // Objekt UNVERÄNDERT, es ist KEIN Error und hat daher KEIN `.message`-Feld.
    // `err.message` wäre hier also `undefined` → verletzt das deklarierte
    // errorSchema (required reason:string) → reproduziert exakt die
    // FST_ERR_FAILED_ERROR_SERIALIZATION-Klasse, die dieser Handler schließen
    // soll. Deshalb zuerst `reason` (vom Rate-Limit-Objekt gesetzt), dann
    // `message` (falls doch ein echter Error durchkommt) als Fallback.
    const anyErr = err as FastifyError & { reason?: string }
    void reply.status(429).send({
      status: 'rate_limited',
      reason: anyErr.reason ?? anyErr.message ?? 'Zu viele Anfragen — bitte kurz warten.',
    })
    return
  }
  if (statusCode >= 400 && statusCode < 500) {
    // z. B. FST_ERR_CTP_EMPTY_JSON_BODY, JSON-Parse-Fehler, FST_ERR_CTP_INVALID_
    // MEDIA_TYPE (415), ungültiger Content-Type. Der semantische Statuscode des
    // Fehlers BLEIBT erhalten (415 bleibt 415, 400 bleibt 400 — kein Zwang auf
    // 400), NUR der Body wird auf {status,reason} normalisiert. Das ist
    // gefahrlos: Routen deklarieren im response-Schema i. d. R. nur 200/400/413
    // (nicht 415 o. Ä.) — undeklarierte Statuscodes passieren Fastifys
    // Response-Schema-Serialisierung ungeprüft (sie wird nur für deklarierte
    // Codes angewendet), es entsteht also KEIN FST_ERR_FAILED_ERROR_SERIALIZATION.
    void reply.status(statusCode).send({ status: 'bad_request', reason: 'Ungültiger Request-Body.' })
    return
  }
  // Echte 500er: vollständig loggen, nach außen nur generisch (kein Message-Leak).
  req.log.error({ err }, 'Unbehandelter Fehler')
  void reply.status(500).send({ status: 'error', reason: 'Interner Fehler.' })
}
