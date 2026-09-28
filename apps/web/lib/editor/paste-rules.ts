// --- Paste-Verhalten: URL-Erkennung (Phase 2c Task 5) ------------------------------
//
// Reine Klassifikation ohne Editor-Bezug — `ui-extensions.ts` verdrahtet das
// Ergebnis als `handlePaste` (Selektion ersetzen mit Link-Mark, oder nackten
// Text+Link-Mark einfügen). Die `literal:true`-Form für die autolink-Variante ist
// dieselbe 2b-Regel wie beim Link-Popover (editor-toolbar.tsx): NIE `[text](url)`
// mit `text === url` — stattdessen die Autolink-Form des Schemas
// (`packages/editor/src/extensions.ts:94-105`).

export type PasteClassification = { kind: 'link-selection' } | { kind: 'autolink' } | { kind: 'default' }

// Volltextiger http(s)/www.-Ausdruck, KEINE eingebetteten Leerzeichen oder
// Zeilenumbrüche (sonst ist es Fließtext mit einer URL darin, kein reiner
// Link-Paste — z. B. "siehe https://… für Details" bleibt `default`).
const BARE_URL_RE = /^(https?:\/\/\S+|www\.\S+)$/i

/** Klassifiziert eingefügten Text für `handlePaste` (Brief-Regel verbatim):
 *  - nackte URL + vorhandene Selektion → `link-selection` (Link-Mark AUF die
 *    Selektion legen, der eingefügte Text bleibt der markierte Text)
 *  - nackte URL ohne Selektion → `autolink` (Text = URL einfügen, Link-Mark mit
 *    `literal:true`)
 *  - alles andere (kein Volltext-URL-Match, oder URL eingebettet in mehr Text)
 *    → `default` (normales Paste-Verhalten, unverändert) */
export function classifyPaste(text: string, hasSelection: boolean): PasteClassification {
  const trimmed = text.trim()
  if (BARE_URL_RE.test(trimmed)) {
    return hasSelection ? { kind: 'link-selection' } : { kind: 'autolink' }
  }
  return { kind: 'default' }
}
