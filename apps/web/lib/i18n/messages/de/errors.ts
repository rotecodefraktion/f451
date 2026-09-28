/**
 * Namespace „errors" — Abbildung eines API-Fehler-`status`-Codes (numerischer
 * HTTP-Status aus einem diskriminierten `client-api.ts`-Ergebnis, z. B.
 * `MovePageResult`/`CreatePageResult`/`UnarchivePageResult`, oder aus einem
 * gefangenen `ClientApiError`/`UploadError`) auf einen lokalisierten Text.
 *
 * Der Server liefert weiterhin seinen eigenen (deutschen) `reason`/`error`-Text
 * im Antwortkörper — der bleibt unangetastet (Server NICHT geändert). Die UI
 * zeigt aber NICHT mehr diesen rohen Text an, sondern nur noch den hier
 * hinterlegten, lokalisierten Text zum `status`-Code (s. {@link apiErrorText}
 * in `lib/i18n/api-error-text.ts` — die zentrale Zuordnungsstelle, die von
 * `new-page-button.tsx`/`tree-node-actions.tsx`/`unarchive-button.tsx`/
 * `tree-dnd.tsx` genutzt wird). Ein nicht gelisteter Status (z. B. 500, 502,
 * Netzwerkfehler) fällt dort auf `error` zurück — DER Grund, warum dieser Key
 * ohne führenden HTTP-Code existiert (kein „500"/„502" etc.).
 */
export const errors = {
  bad_request: 'Ungültige Eingabe.',
  unauthorized: 'Anmeldung erforderlich.',
  forbidden: 'Kein Schreibrecht für diesen Space.',
  not_found: 'Nicht gefunden.',
  conflict: 'Konflikt mit dem aktuellen Stand.',
  payload_too_large: 'Datei ist zu groß.',
  unsupported_media_type: 'Dateityp wird nicht unterstützt.',
  error: 'Etwas ist schiefgelaufen — bitte erneut versuchen.',
} as const
