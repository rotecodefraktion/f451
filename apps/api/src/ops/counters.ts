/**
 * In-memory Fehlerzähler (Task 5, Betrieb — Spec §9 „Fehlerzähler"; ein
 * Prometheus-/Metrik-Export ist laut Spec §11 explizit eine spätere
 * Ausbaustufe, hier bewusst NICHT gebaut). BEWUSST in-memory: ein Neustart
 * des Prozesses nullt alle Zähler — für die drei Fehlerarten hier ausreichend,
 * da sie primär als kurzfristiges Betriebssignal dienen ("läuft gerade etwas
 * schief?"), nicht als historisches Audit-Log. Siehe `deploy/BETRIEB.md`
 * Abschnitt „Monitoring" für die Betriebssicht.
 *
 * EINE Instanz pro Prozess: `buildApp` (`app.ts`) erzeugt sie und reicht sie
 * an die Webhook-/Admin-Routen durch; `server.ts` verwendet dieselbe Instanz
 * (über `app.opsCounters`, siehe Modul-Erweiterung unten) auch für den
 * HEAD-Abgleich-Job (`indexer/drift.ts`), der außerhalb von `buildApp` als
 * eigener `setInterval` läuft — sonst gäbe es zwei unabhängig zählende
 * Instanzen und `GET /admin/status` sähe die Drift-Fehler nie.
 */
export interface OpsCounters {
  /** Erhöht genau EINEN Zähler um 1 — nur in echten Fehlerpfaden aufrufen
   *  (siehe `routes/webhooks.ts`, `indexer/index-space.ts#readPageFileSafe`,
   *  `indexer/drift.ts#checkDrift`), NICHT bei erwarteten/ignorierten
   *  Zuständen (z. B. „unbekanntes Repository", „kein main-Branch"). */
  increment(name: 'webhook_errors' | 'indexer_errors' | 'drift_errors'): void
  /** Aktueller Stand + Zeitpunkt, seit dem gezählt wird (Prozessstart bzw.
   *  Erzeugung dieser Instanz) — `since` macht sichtbar, dass die Zahlen NICHT
   *  historisch sind, sondern seit dem letzten Neustart laufen. */
  snapshot(): { webhookErrors: number; indexerErrors: number; driftErrors: number; since: string }
}

/**
 * Erzeugt eine neue, leere `OpsCounters`-Instanz. `now` ist injizierbar
 * (Test-Hook, Muster wie andernorts im Projekt), Default `() => new Date()`.
 */
export function createOpsCounters(now: () => Date = () => new Date()): OpsCounters {
  let webhookErrors = 0
  let indexerErrors = 0
  let driftErrors = 0
  const since = now().toISOString()

  return {
    increment(name) {
      if (name === 'webhook_errors') webhookErrors += 1
      else if (name === 'indexer_errors') indexerErrors += 1
      else driftErrors += 1
    },
    snapshot() {
      return { webhookErrors, indexerErrors, driftErrors, since }
    },
  }
}

// Modul-Erweiterung (Muster `auth/sessions.ts#AuthUser` für `FastifyRequest`,
// hier analog für `FastifyInstance`): `buildApp` dekoriert die Instanz mit
// der EINEN `OpsCounters`, damit `server.ts` (Prozesseinstiegspunkt) dieselbe
// Instanz für den außerhalb von `buildApp` laufenden Drift-Job wiederverwenden
// kann, statt eine zweite, unabhängig zählende Instanz zu erzeugen.
declare module 'fastify' {
  interface FastifyInstance {
    opsCounters: OpsCounters
  }
}
