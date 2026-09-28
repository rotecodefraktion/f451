/**
 * Dünner fetch-Wrapper auf die f451-HTTP-API.
 *
 * Grundprinzip des MCP-Dienstes (s. `docs/superpowers/plans/2026-07-18-mcp-server.md`):
 * `apps/mcp` wrappt AUSSCHLIESSLICH die HTTP-API — keine direkte DB- oder
 * Forgejo-Kopplung. Damit bleiben Rechteprüfung, Review-Workflow und
 * Indexierung an genau einer Stelle (`apps/api`), und der MCP ist ein
 * zustandsloser Übersetzer MCP↔HTTP.
 *
 * Der Nutzer-Token wird pro Request durchgereicht (der Dienst ist multi-user
 * und hält SELBST KEIN Secret) — s. `auth.ts`.
 */

/** Basis-URL der f451-API. Im Docker-Stack der interne Service-Name, damit der
 *  Verkehr nicht den Umweg über den öffentlichen Reverse-Proxy nimmt. */
const API_URL = process.env.F451_API_URL ?? 'http://api:3001'

/**
 * Fehler mit einer für den Agenten verständlichen Klartext-Meldung.
 *
 * Die Meldung ist bewusst handlungsleitend formuliert („… bitte X tun"),
 * weil ein KI-Agent — anders als ein Mensch vor der UI — nur diesen Text
 * bekommt und daraus seinen nächsten Schritt ableiten muss.
 */
export class F451Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Rohdaten der Fehlerantwort — bei 409 trägt sie `currentSha`/`currentContent`. */
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'F451Error'
  }
}

/** Antwortkörper der API bei Fehlern (best effort — nicht jede Route füllt alles). */
interface ApiErrorBody {
  status?: string
  /** Ältere Lese-Routen nennen den Grund `reason` … */
  reason?: string
  /** … die Schreib-Routen dagegen `error`. Beide Formen kommen vor. */
  error?: string
  /** Handlungsanweisung der API, z.B. `connect` bei fehlendem Provider-Konto. */
  action?: string
  message?: string
  currentSha?: string
  currentContent?: string
  /** Bei 409 auf `POST /api/pages`: die bereits existierende Seite. */
  pageId?: string
}

/**
 * Übersetzt HTTP-Status der f451-API in Agenten-taugliche Meldungen
 * (Fehler-Mapping aus dem Plan). Die API bleibt bei 404 bewusst
 * existenz-orakel-neutral („nicht gefunden ODER kein Zugriff") — diese
 * Unschärfe wird hier NICHT aufgelöst, sondern originalgetreu weitergegeben.
 */
function describeError(status: number, body: ApiErrorBody, retryAfterSec?: number): string {
  const reason = body.reason ?? body.error ?? body.message ?? ''
  switch (status) {
    case 401:
      return 'API-Token ungültig, abgelaufen oder widerrufen. Bitte in f451 unter Einstellungen → Verbindungen ein neues Token erzeugen.'
    case 403:
      // Die API unterscheidet mehrere 403-Ursachen; die für den Agenten
      // folgenreichste ist das fehlende Provider-Konto, denn die kann er NICHT
      // selbst beheben — das muss ein Mensch im Browser tun. Die API markiert
      // diesen Fall über `action: "connect"`.
      if (body.action === 'connect' || /konto|provider|forgejo|github/i.test(reason)) {
        return `Kein verbundenes Forgejo-/GitHub-Konto: Schreiben ist erst möglich, wenn der Nutzer sein Konto in f451 unter Einstellungen → Verbindungen verknüpft hat. Ein API-Token allein genügt dafür nicht. (${reason})`
      }
      if (/lesezugriff|read/i.test(reason)) {
        return `Das verwendete API-Token hat nur Lese-Rechte (Scope "read"). Für diese Aktion wird ein Token mit Scope "write" benötigt. (${reason})`
      }
      return `Keine Berechtigung für diese Aktion. ${reason}`.trim()
    case 404:
      return 'Seite oder Space nicht gefunden — oder kein Lesezugriff darauf.'
    case 409:
      // Zwei verschiedene Konflikte teilen sich den Status: eine bereits
      // existierende Seite (mit `pageId`) und ein überholter Draft-Stand.
      if (body.pageId) {
        return `An dieser Stelle existiert bereits eine Seite (ID ${body.pageId}). Statt sie neu anzulegen, diese Seite bearbeiten. ${reason}`.trim()
      }
      return `Konflikt: Der Draft wurde zwischenzeitlich geändert. Bitte den aktuellen Stand (currentSha/currentContent aus dieser Antwort) als neue Basis nehmen und die eigene Änderung darauf neu aufsetzen — nicht blind überschreiben. ${reason}`.trim()
    case 422:
      return `Die Aktion ist im aktuellen Zustand der Seite nicht möglich. ${reason}`.trim()
    case 429:
      return retryAfterSec !== undefined
        ? `Zu viele Anfragen (Rate-Limit der f451-API). Frühestens in ${retryAfterSec} s erneut versuchen und danach langsamer abfragen.`
        : 'Zu viele Anfragen (Rate-Limit der f451-API). Bitte langsamer abfragen und erneut versuchen.'
    case 502:
      return 'Der Git-Provider (Forgejo) ist nicht erreichbar. Später erneut versuchen.'
    default:
      return `f451-API antwortete mit HTTP ${status}. ${reason}`.trim()
  }
}

/** Bis zu dieser Wartezeit wiederholt der Client einen 429 einmal selbst
 *  (Issue #73), statt den Agenten damit zu behelligen; längere Sperren gibt er
 *  mit der Sekundenzahl weiter. */
const MAX_AUTO_RETRY_SEC = 5

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const sec = Number(header)
  return Number.isFinite(sec) && sec >= 0 ? sec : undefined
}

export interface RequestOptions {
  method?: string
  /** JSON-Körper; wird serialisiert und mit `content-type: application/json` gesendet. */
  body?: unknown
  /** Query-Parameter; `undefined`/`null`-Werte werden weggelassen. */
  query?: Record<string, string | number | boolean | undefined | null>
  /** Erwartetes Antwortformat. `text` für `/raw` (liefert `text/markdown`). */
  accept?: 'json' | 'text'
}

/**
 * Führt einen Aufruf gegen die f451-API im Namen des Nutzers aus.
 *
 * @param token Der `f451_pat_…`-Token des aufrufenden Nutzers (pro Request
 *   aus dem MCP-Authorization-Header, NICHT aus der Serverkonfiguration).
 */
export async function apiRequest<T = unknown>(
  token: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(path, API_URL)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: options.accept === 'text' ? 'text/markdown, text/plain' : 'application/json',
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const send = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (cause) {
      // Netzwerkfehler (API-Container weg/startet noch) sauber von HTTP-Fehlern
      // trennen — sonst liest der Agent das als Rechteproblem.
      throw new F451Error(`f451-API nicht erreichbar (${API_URL}).`, 0, cause)
    }
  }

  let res = await send()
  let retryAfterSec = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined
  if (retryAfterSec !== undefined && retryAfterSec <= MAX_AUTO_RETRY_SEC) {
    await new Promise((resolve) => setTimeout(resolve, retryAfterSec! * 1000))
    res = await send()
    retryAfterSec = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined
  }

  if (!res.ok) {
    let body: ApiErrorBody = {}
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      // Nicht jede Fehlerantwort ist JSON (z.B. Proxy-Fehlerseiten).
    }
    throw new F451Error(describeError(res.status, body, retryAfterSec), res.status, body)
  }

  if (options.accept === 'text') return (await res.text()) as T
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
