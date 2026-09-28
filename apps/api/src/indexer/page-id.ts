import { randomBytes } from 'node:crypto'

/**
 * Stabile Seiten-Id (Phase 3.1, „Stabile Seiten-Id + Backfill + Redirect"):
 * Format `p-<10 Zeichen base36>`, ausschließlich `[a-z0-9-]` — bewusst eine
 * Teilmenge von `draftBranchName`s erlaubter Zeichenmenge (`[a-z0-9._-]`,
 * `drafts/branch-name.ts`). Jede über `generatePageId` erzeugte Id ist damit
 * bereits vollständig git-branch-sicher: `draftBranchName(id)` hängt NIE
 * einen Hash-Suffix an (der Suffix greift nur, wenn `sanitize` irgendein
 * Zeichen ersetzen musste, s. dortiger Kommentar) — der Draft-Branch bleibt
 * für neu angelegte/nachgerüstete Seiten also stets exakt `draft/<id>`.
 *
 * `node:crypto#randomBytes` statt `Math.random` (kollisionsarm, KEINE neue
 * Dependency — Vorgabe der Phase). 10 Zeichen base36 ≈ 51,7 Bit Entropie:
 * für die zu erwartende Seitenzahl (Zehntausende, nicht Milliarden) reicht
 * das bei Weitem — nach dem Geburtstagsparadoxon bräuchte es weit über 10
 * Millionen erzeugte Ids, um auch nur eine 1%-Kollisionswahrscheinlichkeit zu
 * erreichen. Aufrufer, denen selbst das nicht genügt (Backfill über sehr
 * viele Seiten hinweg), dedupen zusätzlich gegen die IDs, die im selben Lauf
 * bereits vergeben wurden (s. `routes/admin.ts#backfillSpace`).
 */

const ID_PREFIX = 'p-'
const ID_BODY_LENGTH = 10
const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Erzeugt eine neue, zufällige, stabile Seiten-Id (`p-<10-stelliges base36>`). */
export function generatePageId(): string {
  let body = ''
  for (const byte of randomBytes(ID_BODY_LENGTH)) {
    body += BASE36_ALPHABET[byte % BASE36_ALPHABET.length]
  }
  return `${ID_PREFIX}${body}`
}
