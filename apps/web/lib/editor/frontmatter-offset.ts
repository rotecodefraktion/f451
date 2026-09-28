import { splitFrontmatter } from '@f451/markdown'
import type { SupportFinding } from '@f451/editor'

/**
 * Fix Final-Review Phase 2c Task 6 (Critical): `checkEditorSupport` (s. dortiger
 * Kommentar „Fundstelle im Body") berechnet `finding.line` grundsätzlich BODY-
 * relativ — der Vertrag bleibt unverändert (auch `evaluateModeSwitch`,
 * `mode-switch-core.ts`, gibt diese Zeilen unverändert weiter, s. dessen Tests).
 * Jede Stelle in `apps/web`, die eine Zeilennummer auf das VOLLE Dokument
 * anwendet — CodeMirror-Diagnostics/Scroll (`raw-editor.tsx`), die Anzeige im
 * `findings-panel` — muss den Frontmatter-Block dazuzählen, sonst landen Gutter,
 * Scroll-Ziel und „Zeile N" mitten im Frontmatter statt auf der echten Fundstelle.
 *
 * Diese beiden Funktionen sind die EINZIGE Stelle, die diesen Versatz kennt —
 * jeder Aufrufer wendet ihn EINMAL an, bevor ein `SupportFinding[]` in einen
 * React-State (der dann angezeigt/verklickt wird) einfließt. Das
 * `findings-panel` selbst rechnet nichts um (s. dortiger Kommentar) — die
 * Zeilen, die dort ankommen, sind bereits volle Dokumentzeilen.
 */

/** Zeilenanzahl des führenden Frontmatter-Blocks (inkl. `---`-Zäune) in
 *  `fullMarkdown` — der Versatz, um den eine BODY-relative Zeile (wie
 *  `checkEditorSupport` sie liefert) auf die echte Dokumentzeile umgerechnet
 *  werden muss. `0` ohne Frontmatter. Nutzt `splitFrontmatter` (@f451/markdown)
 *  als alleinige Quelle der Frontmatter-Erkennung — keine eigene Fence-Suche.
 *
 *  `frontmatterRaw` endet laut dessen Vertrag mit dem Zeilenumbruch direkt
 *  nach der schließenden Zäune (`\n` oder `\r\n` — beide enthalten genau ein
 *  `\n`-Zeichen), außer das Frontmatter steht am Dateiende ohne folgenden
 *  Body (dann ist `body` ohnehin leer und der exakte Offset-Wert irrelevant).
 *  Die Anzahl der `\n`-Zeichen in `frontmatterRaw` ist deshalb genau die
 *  Anzahl der Dokumentzeilen, die vor Body-Zeile 1 liegen. */
export function frontmatterLineOffset(fullMarkdown: string): number {
  const { frontmatterRaw } = splitFrontmatter(fullMarkdown)
  if (frontmatterRaw === '') return 0
  return (frontmatterRaw.match(/\n/g) ?? []).length
}

/** Verschiebt `line` in jedem Befund MIT Zeile (ausschließlich `kind:
 *  'unsupported'`) um `offset` — Befunde ohne Zeile (`frontmatter`,
 *  `normalization`) bleiben unverändert. Reine Funktion, keine Mutation von
 *  `findings`. */
export function offsetFindingLines(findings: SupportFinding[], offset: number): SupportFinding[] {
  if (offset === 0) return findings
  return findings.map((finding) => (finding.line === undefined ? finding : { ...finding, line: finding.line + offset }))
}
