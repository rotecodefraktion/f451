/**
 * Bildet einen numerischen API-Fehlerstatus (aus einem diskriminierten
 * `client-api.ts`-Ergebnis, z. B. `MovePageResult.status`/`CreatePageResult.status`/
 * `UnarchivePageResult.status`, oder aus einem gefangenen `ClientApiError.status`/
 * `UploadError.status`) auf einen lokalisierten Text ab — Namespace `errors`
 * (`messages/{de,en}/errors.ts`).
 *
 * Nicht-Komponenten-Modul (kein `useT()`/`getT()` — s. `lib/i18n/provider.tsx`/
 * `server.ts`): `t` kommt als Parameter vom Aufrufer (Client-Komponenten
 * `new-page-button.tsx`/`tree-node-actions.tsx`/`unarchive-button.tsx`/
 * `tree-dnd.tsx`, jeweils bereits per `useT()` gebunden).
 *
 * Der Server liefert weiterhin seinen eigenen (deutschen) `reason`/`error`-Text
 * im Antwortkörper (Server NICHT geändert) — die UI zeigt den aber NICHT mehr
 * direkt an, sondern nur noch den hier hinterlegten Text zum `status`-Code.
 * Ein nicht gelisteter Status (500, 502, Netzwerkfehler `status: 0`, …) fällt
 * auf `errors.error` zurück (s. Modul-Kommentar `messages/de/errors.ts`).
 */
import type { DotPaths, Params } from './format.js'
import type { Messages } from './types.js'

type ErrorKey = keyof Messages['errors']

const STATUS_KEYS: Record<number, ErrorKey> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
}

/** Lokalisierter Fehlertext für einen HTTP-Status — Fallback `errors.error`
 *  bei jedem nicht in {@link STATUS_KEYS} gelisteten Code. */
export function apiErrorText(t: (key: DotPaths<Messages>, params?: Params) => string, status: number): string {
  const key: ErrorKey = STATUS_KEYS[status] ?? 'error'
  return t(`errors.${key}`)
}
