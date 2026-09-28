/**
 * Token-Durchreichung pro Request.
 *
 * Der MCP-Dienst ist multi-user und hält selbst KEIN Secret: Der Agent schickt
 * seinen persönlichen `f451_pat_…`-Token im `Authorization`-Header, der Dienst
 * reicht ihn 1:1 an die f451-API weiter. Die eigentliche Prüfung (Hash-Lookup,
 * Ablauf, Widerruf, Scope) passiert ausschließlich in `apps/api` — hier wird
 * NICHT validiert, nur transportiert. Deshalb genügt eine Formatprüfung, und
 * ein falscher Token äußert sich als 401 der API (in `client.ts` gemappt).
 */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

/** Präfix persönlicher f451-Zugriffstokens (s. `apps/api/src/auth/crypto.ts`). */
const API_TOKEN_PREFIX = 'f451_pat_'

/** Meldung bei fehlendem Header — nennt dem Agenten den konkreten nächsten Schritt. */
export const MISSING_TOKEN_MESSAGE =
  'Kein API-Token übermittelt. Bitte in f451 unter Einstellungen → Verbindungen ein persönliches Zugriffs-Token erzeugen und als "Authorization: Bearer f451_pat_…" an den MCP-Server senden.'

/**
 * Zieht den f451-Token aus einem `Authorization`-Header.
 *
 * @returns Der Token oder `undefined`, wenn der Header fehlt oder nicht wie ein
 *   f451-Token aussieht.
 */
export function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return undefined
  const token = match[1]!.trim()
  return token.startsWith(API_TOKEN_PREFIX) ? token : undefined
}

/**
 * Verpackt den Token als `AuthInfo` für den SDK-Transport, damit er in den
 * Tool-Handlern über `extra.authInfo` ankommt.
 *
 * `clientId`/`scopes` sind hier Platzhalter: Der MCP kennt weder den Nutzer
 * noch dessen Scope — beides weiß nur die f451-API. Ein `read`-Token, das eine
 * Schreib-Aktion versucht, läuft daher bis zur API durch und wird dort mit 403
 * abgewiesen (in `client.ts` in eine klare Meldung übersetzt).
 */
export function toAuthInfo(token: string): AuthInfo {
  return { token, clientId: 'f451-mcp', scopes: [] }
}

/** Liest den durchgereichten Token aus dem `extra`-Argument eines Tool-Handlers. */
export function tokenFromExtra(extra: { authInfo?: AuthInfo }): string {
  const token = extra.authInfo?.token
  if (!token) throw new Error(MISSING_TOKEN_MESSAGE)
  return token
}
