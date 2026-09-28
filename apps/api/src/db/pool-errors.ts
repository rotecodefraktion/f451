/** Minimales Logger-Stück (Fastify-kompatibel) — nur `error` wird gebraucht. */
export interface PoolErrorLogger {
  error(payload: { err: unknown }, message: string): void
}

/** Nur das, was hier benutzt wird — `pg.Pool` erfüllt es (EventEmitter), und
 *  Tests können einen nackten `EventEmitter` hereinreichen. */
export interface PoolErrorSource {
  on(event: 'error', listener: (err: unknown) => void): unknown
}

/**
 * Hängt einen `'error'`-Listener an einen Verbindungspool — ZWINGEND, sonst
 * beendet ein Datenbankfehler den gesamten API-Prozess.
 *
 * Hintergrund (realer Ausfall): Wird Postgres neu gestartet, beendet der Server
 * alle offenen Verbindungen mit `57P01 — terminating connection due to
 * administrator command`. `pg-pool` reicht das als `'error'`-Event am Pool
 * weiter, und zwar auch für Verbindungen, die gerade im Leerlauf liegen, also
 * ohne laufende Abfrage, der man den Fehler zuordnen könnte. Ein EventEmitter
 * ohne `'error'`-Listener wirft das Ereignis als unbehandelte Ausnahme: Der
 * Prozess starb mit Exit-Code 1 und blieb tot, weil auch keine
 * Wiederanlaufregel gesetzt war.
 *
 * Der Fehler wird bewusst NUR protokolliert: `pg-pool` verwirft die kaputte
 * Verbindung selbst und baut bei der nächsten Anfrage eine neue auf. Die API
 * ist damit ein paar Sekunden nach dem Datenbank-Neustart von allein wieder
 * arbeitsfähig — ein Prozessende wäre die deutlich schlechtere Antwort auf ein
 * Ereignis, von dem sich der Dienst selbst erholen kann.
 */
export function attachPoolErrorHandler(pool: PoolErrorSource, log: PoolErrorLogger): void {
  pool.on('error', (err: unknown) => {
    log.error(
      { err },
      'Fehler an einer Datenbankverbindung im Leerlauf (Pool) — Verbindung wird verworfen, '
        + 'die nächste Anfrage baut eine neue auf.',
    )
  })
}
