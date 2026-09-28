/**
 * Session-Helfer für Server Components: liest den aktuellen Benutzer über
 * `GET /api/me`. Wird von jeder geschützten Server-Page verwendet, um den
 * Session-Cookie (durchgereicht via `cookies()`) gegen die API zu prüfen.
 */

import { ApiError, apiFetch } from './api'

export interface Me {
  id: string
  email: string
  displayName: string
  connections: {
    forgejo: boolean
    github: boolean
  }
  /** Verknüpft, aber vom Provider abgelehnt — muss neu verbunden werden. */
  expiredConnections: {
    forgejo: boolean
    github: boolean
  }
}

/**
 * Lädt den aktuellen Benutzer. Liefert `null` bei fehlender/ungültiger Session
 * (401 — der normale „nicht eingeloggt"-Fall), NICHT bei anderen Fehlern:
 * Netzwerkfehler und sonstige HTTP-Fehler (z. B. 500) werden weitergeworfen,
 * damit aufrufende Server Components sie als Fehlerbanner behandeln (Plan
 * Abschnitt 9) statt sie fälschlich mit „nicht eingeloggt" gleichzusetzen.
 */
export async function getMe(cookie: string | undefined): Promise<Me | null> {
  try {
    return await apiFetch<Me>('/api/me', { cookie })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}
