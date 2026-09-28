/**
 * Einstiegspunkt des Pakets.
 *
 * Bis hierher wurde `@f451/design-tokens` nur BEIM BAUEN ausgeführt
 * (`src/generate-css.ts` schreibt `dist/tokens.css`, die Web-App kopiert sie
 * sich); importierbar war es nicht. Die Einstellungsseite „Erscheinungsbild"
 * braucht die Tokens dagegen zur Laufzeit — Rollen, Sperren und Werte —, und
 * zwar aus derselben Quelle, aus der auch das CSS entsteht. Deshalb hier ein
 * Einstiegspunkt statt einer zweiten Liste in der Web-App.
 */
export * from './catalog.js'
export * from './tokens.js'
export * from './contrast.js'
// Die CSS-Schreibweise einer Mischvorschrift — die Seite zeigt sie für die
// abgeleiteten Tokens an, die sich nicht zu einem Farbwert ausrechnen lassen.
export { formulaToCss } from './css.js'
// Hausstil der Diagramme: Generator (MCP) und Formenbibliothek (Web) zeichnen daraus.
export { farbe, mass, schriftFamilie, stil as diagrammStil, mxStil } from './diagram.js'
