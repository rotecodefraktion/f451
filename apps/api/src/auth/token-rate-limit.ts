/**
 * Anfragebudget für API-Token-Aufrufe (Issue #73): pro NUTZER gezählt, nicht
 * pro IP. Die Routen-Limits von @fastify/rate-limit zählen pro Client-IP —
 * alle Agenten hinter einem Proxy (oder im MCP-Dienst, der für jeden Nutzer
 * von derselben Adresse anfragt) teilten sich sonst einen Topf, und ein
 * einzelner Agent mit Massenabfragen sperrte alle anderen aus.
 *
 * Pro Nutzer statt pro Token: wer mehrere Tokens anlegt, vervielfacht sein
 * Budget damit nicht.
 *
 * Festes Zeitfenster, im Speicher des einen API-Prozesses (wie der
 * Berechtigungs-Cache in `permissions.ts`). Abgelaufene Fenster werden beim
 * nächsten Zugriff ersetzt; wächst die Map dennoch, räumt `sweep` sie ab.
 */

export interface TokenRateLimit {
  max: number
  windowMs: number
}

export type TokenRateDecision = { allowed: true } | { allowed: false; retryAfterSec: number }

const SWEEP_THRESHOLD = 10_000

export function createTokenRateLimiter(
  limit: TokenRateLimit,
  now: () => number = Date.now,
): (key: string) => TokenRateDecision {
  const windows = new Map<string, { start: number; count: number }>()

  function sweep(t: number): void {
    for (const [key, w] of windows) {
      if (t - w.start >= limit.windowMs) windows.delete(key)
    }
  }

  return (key) => {
    const t = now()
    let w = windows.get(key)
    if (!w || t - w.start >= limit.windowMs) {
      if (windows.size >= SWEEP_THRESHOLD) sweep(t)
      w = { start: t, count: 0 }
      windows.set(key, w)
    }
    if (w.count >= limit.max) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + limit.windowMs - t) / 1000)) }
    }
    w.count += 1
    return { allowed: true }
  }
}
