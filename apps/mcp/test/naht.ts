import { vi } from 'vitest'

/**
 * Die Prüfnaht der MCP-Werkzeuge — eine, gemeinsam für alle.
 *
 * Was ein guter Test hier prüft, ist das, was über die Leitung geht und was der
 * Agent zu lesen bekommt, nicht wie es intern zustande kommt. Ein Test, der ein
 * nachgebautes Schema gegen eine Prüffunktion hält, belegt nur, dass die
 * Prüfbibliothek funktioniert.
 *
 * Deshalb: Die ECHTEN Tools werden an einer Attrappen-Server-Instanz
 * registriert, der ECHTE Handler wird aufgerufen, `apiRequest` bleibt echt —
 * ersetzt ist ausschließlich der Netzzugriff (`fetch`, Muster aus
 * `client.test.ts`).
 */

export type Handler = (args: unknown, extra: unknown) => Promise<ToolResult>

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

/** Attrappen-McpServer: sammelt registrierte Tools zum direkten Aufrufen. */
export function fakeServer() {
  const handlers = new Map<string, Handler>()
  return {
    server: {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler)
      },
    },
    handlers,
  }
}

/** Antwort-Attrappe der f451-API. */
export function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

/**
 * Ersetzt `fetch` durch eine Attrappe, die der Reihe nach antwortet.
 *
 * Ohne Angabe antwortet sie auf jeden Aufruf mit 200 und einem leeren Objekt;
 * mit Angabe wird die Liste abgearbeitet und die letzte Antwort wiederholt —
 * so bleiben Tests lesbar, die nur den EINEN Aufruf betrachten, der sie
 * interessiert.
 */
export function mockFetch(antworten: Response[] = [respond(200, {})]) {
  let i = 0
  const spy = vi.fn(async () => antworten[Math.min(i++, antworten.length - 1)]!)
  vi.stubGlobal('fetch', spy)
  return spy
}

/** Der ausgewertete Rumpf des n-ten HTTP-Aufrufs. */
export function bodyOf(spy: ReturnType<typeof mockFetch>, n = 0): Record<string, unknown> {
  const [, init] = spy.mock.calls[n] as unknown as [URL, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/** Ziel-URL und Methode des n-ten HTTP-Aufrufs. */
export function callOf(spy: ReturnType<typeof mockFetch>, n = 0): { url: URL; init: RequestInit } {
  const [url, init] = spy.mock.calls[n] as unknown as [URL, RequestInit]
  return { url, init }
}

/** Der Text, den der Agent zu lesen bekommt. */
export function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join('\n')
}

export const authExtra = { authInfo: { token: 'f451_pat_x', clientId: 'f451-mcp', scopes: [] } }
