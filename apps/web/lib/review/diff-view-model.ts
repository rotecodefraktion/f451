import type { DiffBlock } from '@f451/markdown'
import type { T } from '../i18n/types.js'

/**
 * Reine Darstellungs-Helfer für die Review-Diff-Ansicht (Phase 2d Task 7) —
 * hier isoliert (statt inline in `components/review/*.tsx`), damit sie ohne
 * React/DOM testbar sind (`lib/**`, Muster `lib/editor/reset-recovery.ts`).
 *
 * `GET /api/pages/:id/review` (`@f451/markdown#diffMarkdown`) liefert je
 * Block nur `kind`/`html`/`anchor` — KEINE kuratierten Sprungmarken-Titel wie
 * im Mockup (`docs/design/mockups/review-diff.html`, z. B. "Health-Check-
 * Kriterium präzisiert" + Abschnittspfad "Überblick · Absatz 1"). Die rechte
 * "Änderungen"-Liste leitet ihr Label deshalb aus dem reinen Textinhalt des
 * Blocks ab (Tags entfernt, gekürzt) statt eine Kuration vorzutäuschen, die
 * serverseitig nicht existiert (YAGNI — eine Reviewer-Liste hat aus demselben
 * Grund denselben Backlog-Status, s. `apps/api/README.md`).
 */

/** Entfernt HTML-Tags und normalisiert Whitespace — reine Textnäherung für
 *  Sprungmarken-Labels, kein vollwertiger HTML-Parser (reicht für die vom
 *  Server bereits sanitisierten Diff-HTML-Fragmente, `diff.ts`-Kopfkommentar). */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Kürzt auf `max` Zeichen mit „…"-Suffix — schneidet am letzten Leerzeichen
 *  vor der Grenze ab (sofern eines in den letzten 20 Zeichen liegt), damit
 *  nie mitten in einem Wort abgeschnitten wird. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace >= 0 && lastSpace > max - 20 ? cut.slice(0, lastSpace) : cut
  return `${base.trimEnd()}…`
}

/** `.dchange`-Modifier-Klasse (`add`/`chg`) für die zwei Block-Arten, die im
 *  Visuell-Tab als Inline-Markierung erscheinen — `removed` nutzt stattdessen
 *  `<details class="removed">` (kein `.dchange`), `same` bleibt unmarkiert
 *  ("nackt", Brief wörtlich). */
export function dchangeModifierClass(kind: DiffBlock['kind']): 'add' | 'chg' | null {
  if (kind === 'added') return 'add'
  if (kind === 'changed') return 'chg'
  return null
}

/** `.dtag`-Beschriftung für `added`/`changed` — `null` für `same`/`removed`
 *  (die keinen `.dtag` tragen, s. {@link dchangeModifierClass}). */
export function dtagLabel(t: T, kind: DiffBlock['kind']): string | null {
  if (kind === 'added') return t('review.diff.tag.added')
  if (kind === 'changed') return t('review.diff.tag.changed')
  return null
}

/** Blöcke für die rechte "Änderungen"-Sprungmarkenliste — `same` bleibt außen
 *  vor (kein Sprungziel; jeder Block trägt zwar einen Anchor, Diff-Vertrag
 *  `packages/markdown/src/diff.ts`, aber nur Änderungen sind es wert, gelistet
 *  zu werden). */
export function changedBlocks(blocks: readonly DiffBlock[]): DiffBlock[] {
  return blocks.filter((b) => b.kind !== 'same')
}

const RAIL_LABEL_MAX = 90

/** Menschenlesbares Label für einen Eintrag der "Änderungen"-Liste — reiner
 *  Textauszug aus `block.html` (s. Modul-Kommentar). Ein leerer/whitespace-
 *  only Auszug (z. B. eine reine Tabellen-/Bild-Änderung ohne umgebenden
 *  Fließtext) fällt auf ein generisches Kind-Label zurück, damit nie ein
 *  leerer Listeneintrag entsteht. */
export function railLabel(t: T, block: DiffBlock): string {
  const text = stripHtmlToText(block.html)
  if (text.length > 0) return truncate(text, RAIL_LABEL_MAX)
  if (block.kind === 'added') return t('review.changesList.newBlock')
  if (block.kind === 'removed') return t('review.changesList.removedBlock')
  return t('review.changesList.changedBlock')
}
