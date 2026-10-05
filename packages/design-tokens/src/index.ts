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
export { checkValue, type ValueCheck } from './grammar.js'
// Layer resolver, cross-token rules and the CSS difference of a resolved theme.
export * from './theme.js'
// Theme file parser: file names without dashes in, a grammar-checked ThemeLayer out.
export * from './theme-file.js'
// Theme stylesheet checker (f451#61): rules, font references, font URL rewrite.
export * from './stylesheet.js'
// Built-in theme templates (Fokus, Klar & Warm, System / Raster, Werkbank, Rotecodefraktion).
export { builtinTemplates, type BuiltinTemplate } from './builtin-themes.js'
// Die CSS-Schreibweise einer Mischvorschrift — die Seite zeigt sie für die
// abgeleiteten Tokens an, die sich nicht zu einem Farbwert ausrechnen lassen.
export { formulaToCss } from './css.js'
// Hausstil der Diagramme: Generator (MCP) und Formenbibliothek (Web) zeichnen daraus.
export { farbe, mass, schriftFamilie, stil as diagrammStil, mxStil } from './diagram.js'
