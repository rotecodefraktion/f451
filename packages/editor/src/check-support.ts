import { parseMarkdownTree, parsePage, splitFrontmatter } from '@f451/markdown'
import { collectUnsupported, markdownToDoc, UnsupportedMarkdownError } from './from-markdown.js'
import { docToMarkdown } from './to-markdown.js'

// --- Validierungs-API gegen stillen Verlust (Task 5, Phase 2b) ----------------------
//
// checkEditorSupport ist der Schutz, auf dem 2c (Editor-UI) den WYSIWYG-Moduswechsel
// baut: BEVOR ein Dokument in den Editor geladen wird, muss geprüft werden, ob der
// Rück-Serialisierungspfad (docToMarkdown(markdownToDoc(body))) etwas verlieren oder
// stillschweigend verändern würde. Vertrag (Plan, verbatim):
//
//   - 'unsupported' (rohes HTML, Fußnoten, Referenz-Links/-Bilder/-Definitionen — die
//     fünf Knotentypen aus from-markdown.ts#UNSUPPORTED_TYPES): der WYSIWYG-Wechsel
//     MUSS verweigert werden (canEdit: false). Der Roh-Text-Modus bleibt davon
//     unberührt immer möglich — checkEditorSupport entscheidet nur über den
//     WYSIWYG-Pfad, nicht über die Bearbeitbarkeit des Dokuments insgesamt.
//   - 'normalization' (der Roundtrip verändert Bytes, obwohl jeder Knoten abbildbar
//     ist — andere Bullet-Zeichen, Setext- statt ATX-Headings, `_kursiv_` statt
//     `*kursiv*`, ein Bild mitten im Satz, das zu einem eigenen Block wird, …):
//     canEdit bleibt true, aber der Aufrufer bekommt `canonicalBody` — die Form, die
//     der Editor tatsächlich speichern würde, VOR jedem Verlust sichtbar gemacht.
//   - 'frontmatter' (Schemafehler aus parsePage, z. B. "tags: muss eine Liste von
//     Strings sein"): reine Warnung, canEdit bleibt true — das Frontmatter selbst
//     durchläuft splitFrontmatter/joinFrontmatter ohnehin byte-identisch (Task 1), der
//     Editor rührt es nicht an.
//
// 'unsupported' DOMINIERT: liegt auch nur ein einziger nicht abbildbarer Knoten vor,
// ist canEdit false, unabhängig von etwaigen Frontmatter-Findings (Kombinationsfall,
// s. Tests) — es gibt in diesem Fall auch KEIN canonicalBody, weil markdownToDoc an
// exakt dieser Stelle ohnehin werfen würde (ein Roundtrip-Vergleich wäre bedeutungslos).
//
// Befund-Sammlung: VOLLSTÄNDIG, nicht beim ersten Fund abgebrochen. Für 'unsupported'
// liefert collectUnsupported (Task 3, from-markdown.ts) dafür bereits die nicht
// werfende Sammel-Traversierung — checkEditorSupport nutzt genau diese, nicht den
// werfenden markdownToDoc-Pfad, um die volle Liste zu bekommen.

/** Ein einzelner Befund aus {@link checkEditorSupport}. `line`/`nodeType` sind nur bei
 *  `kind: 'unsupported'` gesetzt (Fundstelle im Body, 1-basiert wie mdast-Positionen). */
export interface SupportFinding {
  kind: 'unsupported' | 'normalization' | 'frontmatter'
  message: string
  line?: number
  nodeType?: string
}

/** Ergebnis von {@link checkEditorSupport}. `canonicalBody` ist NUR gesetzt, wenn
 *  genau ein `normalization`-Finding vorliegt — die Body-nur-Form (ohne Frontmatter),
 *  die der Editor beim Speichern tatsächlich erzeugen würde. */
export interface EditorSupportReport {
  canEdit: boolean
  findings: SupportFinding[]
  canonicalBody?: string
}

/** Prüft ein VOLLES Markdown-Dokument (inkl. optionalem Frontmatter) darauf, ob ein
 *  WYSIWYG-Moduswechsel im Editor verlustfrei möglich ist. Wirft nie — jedes Ergebnis
 *  ist ein Report, den der Aufrufer (2c) dem Nutzer anzeigen kann. */
export function checkEditorSupport(markdown: string): EditorSupportReport {
  const { body } = splitFrontmatter(markdown)
  const findings: SupportFinding[] = []

  // --- Frontmatter (Task 1/parsePage) — läuft immer, unabhängig vom Rest -----------
  const { frontmatterErrors } = parsePage(markdown)
  for (const message of frontmatterErrors) {
    findings.push({ kind: 'frontmatter', message })
  }

  // --- Nicht abbildbare Syntax — VOLLSTÄNDIGE Liste über collectUnsupported --------
  const tree = parseMarkdownTree(body)
  const unsupported = collectUnsupported(tree)
  for (const finding of unsupported) {
    findings.push({
      kind: 'unsupported',
      // Dieselbe Meldung wie UnsupportedMarkdownError (Task 3) — eine Textquelle für
      // "warum nicht abbildbar", ob geworfen (markdownToDoc) oder gesammelt (hier).
      message: new UnsupportedMarkdownError(finding.type, finding.line).message,
      line: finding.line,
      nodeType: finding.type,
    })
  }

  if (unsupported.length > 0) {
    // 'unsupported' dominiert: canEdit false, kein canonicalBody (markdownToDoc würde
    // an dieser Stelle ohnehin werfen — Roh-Modus bleibt trotzdem immer möglich, das
    // entscheidet dieser Report nicht).
    return { canEdit: false, findings }
  }

  // --- Normalisierung — nur relevant, wenn jeder Knoten abbildbar ist --------------
  //
  // Robustheitsgurt (Final-Review Phase 2b, Empfehlung des Final-Reviewers): der
  // "Wirft nie"-Vertrag dieser Funktion darf nicht davon abhängen, dass from-markdown/
  // to-markdown JEDEN validen Markdown-Input crashfrei verarbeiten (Befund I2 hat genau
  // so einen Fall — ein leeres Blockquote — behoben; ein KÜNFTIGES, heute unbekanntes
  // Konstrukt könnte denselben Fehlerklasse erneut auslösen). Ein unerwarteter
  // struktureller Fehler an dieser Stelle wird deshalb als blockierender Befund
  // gemeldet statt als Exception zu entkommen — analog zu 'unsupported' oben (kein
  // canonicalBody, der Roundtrip-Vergleich wäre ohnehin bedeutungslos).
  try {
    const canonicalBody = docToMarkdown(markdownToDoc(body))
    if (canonicalBody !== body) {
      findings.push({
        kind: 'normalization',
        message: 'Formatierung wird beim Bearbeiten normalisiert.',
      })
      return { canEdit: true, findings, canonicalBody }
    }

    return { canEdit: true, findings }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    findings.push({
      kind: 'unsupported',
      message: `Unerwarteter Fehler beim Bearbeiten-Roundtrip: ${message}`,
    })
    return { canEdit: false, findings }
  }
}
