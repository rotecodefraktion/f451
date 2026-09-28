import { checkEditorSupport } from '@f451/editor'
import type { SupportFinding } from '@f451/editor'

/**
 * Reine Entscheidungslogik für den Roh→WYSIWYG-Moduswechsel (Phase 2c Task 6,
 * Spec-Anker: „Syntax, die der Editor nicht darstellen kann, wird VOR dem
 * Wechsel gemeldet … Validierung heißt: warnen und Verlust verhindern, nicht
 * blockieren."). Baut direkt auf `checkEditorSupport` (@f451/editor, „wirft
 * nie") auf — dieses Modul fügt nur die DREI Ausgänge hinzu, die
 * `mode-switch.tsx` braucht, ohne React/DOM-Bezug (node-vitest-testbar wie
 * `autosave.ts`).
 *
 * WYSIWYG→Roh ist NICHT Teil dieser Funktion — dieser Wechsel ist laut Spec
 * immer erlaubt (nur `flushNow` davor, s. `editor-root.tsx`) und braucht
 * keine Entscheidungslogik.
 *
 * `findings` ist in ALLEN drei Ausgängen vorhanden (auch im „direkt erlaubt"-
 * Fall) — sonst gingen reine `frontmatter`-Befunde (canEdit bleibt true, aber
 * sollen laut Brief „als Warnung ins Panel") beim direkten Wechsel verloren.
 */
/** Welcher der beiden Editoren gerade sichtbar ist (`editor-root.tsx`s
 *  `StartMode`-Typ ist der Anfangswert davon — beide Typen bewusst getrennt
 *  gehalten: `StartMode` beschreibt eine EINMALIGE Lade-Entscheidung,
 *  `EditorMode` den laufenden, wechselbaren Zustand der Session). */
export type EditorMode = 'wysiwyg' | 'raw'

export type ModeSwitchResult =
  | { allowed: true; needsConfirmation: false; findings: SupportFinding[] }
  | { allowed: true; needsConfirmation: true; canonicalBody: string; findings: SupportFinding[] }
  | { allowed: false; findings: SupportFinding[] }

/** Prüft, ob `fullMarkdown` (VOLLES Dokument inkl. Frontmatter — derselbe
 *  Vertrag wie `checkEditorSupport`) verlustfrei in den WYSIWYG-Modus
 *  wechseln kann. Wirft nie (konsumiert den „wirft nie"-Vertrag von
 *  `checkEditorSupport` unverändert weiter, auch für das leere Dokument). */
export function evaluateModeSwitch(fullMarkdown: string): ModeSwitchResult {
  const report = checkEditorSupport(fullMarkdown)

  if (!report.canEdit) {
    // Mindestens ein nicht abbildbarer Knoten (rohes HTML, Fußnoten, …) —
    // der Wechsel wird verweigert, die volle Befundliste (inkl. Zeilen)
    // erklärt warum.
    return { allowed: false, findings: report.findings }
  }

  const needsConfirmation = report.findings.some((finding) => finding.kind === 'normalization')
  if (needsConfirmation && report.canonicalBody !== undefined) {
    // Roundtrip verändert Bytes, aber alles ist abbildbar — Bestätigung vor
    // dem stillen Normalisieren (Spec: „warnen und Verlust verhindern").
    return { allowed: true, needsConfirmation: true, canonicalBody: report.canonicalBody, findings: report.findings }
  }

  // Kanonisch, oder nur `frontmatter`-Befunde (die das Frontmatter betreffen,
  // das der WYSIWYG-Editor ohnehin nicht anfasst) — direkt erlaubt.
  return { allowed: true, needsConfirmation: false, findings: report.findings }
}
