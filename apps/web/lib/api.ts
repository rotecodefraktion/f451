/**
 * Serverseitiger API-Client für Server Components.
 *
 * Server-zu-Server-Aufrufe gehen direkt an `process.env.API_URL` (nicht über die
 * Next-Rewrites, die nur für Client-Fetches gedacht sind). Der Session-Cookie wird
 * explizit als Parameter durchgereicht, weil Server Components keinen impliziten
 * Cookie-Kontext an `fetch` weitergeben.
 */

const DEFAULT_API_URL = 'http://localhost:3001'

/** Fehler eines API-Aufrufs mit HTTP-Status. `status === 0` = Netzwerk-/Verbindungsfehler. */
export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export interface ApiFetchInit extends Omit<RequestInit, 'headers'> {
  /** Roher `Cookie`-Header-Wert, der an die API weitergereicht wird (Session-Forwarding). */
  cookie?: string
  headers?: HeadersInit
}

function apiBase(): string {
  return process.env.API_URL ?? DEFAULT_API_URL
}

/**
 * Ruft die interne API auf und liefert den JSON-Body typisiert zurück.
 * Wirft {@link ApiError} bei HTTP-Fehlern (mit `status`) und bei Netzwerkfehlern (`status === 0`).
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { cookie, headers, ...rest } = init
  const merged = new Headers(headers)
  if (cookie) merged.set('cookie', cookie)

  let res: Response
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...rest,
      headers: merged,
      // Server Components dürfen nie stale Daten cachen: jede Anfrage frisch.
      cache: rest.cache ?? 'no-store',
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ApiError(0, `Netzwerkfehler beim Abruf von ${path}: ${message}`)
  }

  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    throw new ApiError(res.status, `API antwortete mit ${res.status} für ${path}`, body)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
