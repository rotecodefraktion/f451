import { createHash } from 'node:crypto'

/**
 * Git-sichere Branch-Namensmappung für Draft-Branches (Plan Task 2, Global
 * Constraints: `draft/<pageId>` — `pageId` kann `:` und `/` enthalten
 * (Fallback-Ids der Form `path:<space>/<datei>`, siehe `index-space.ts`), Git
 * erlaubt aber nicht jedes Zeichen in Ref-Namen (Space, `:`, `~`, `^`, `?`,
 * `*`, `[`, `\`, aufeinanderfolgende `/` etc.). Erlaubte Zeichenmenge hier
 * bewusst eng: `[a-z0-9._-]` — jedes andere Zeichen (inkl. Großbuchstaben,
 * Unicode, `/`) wird durch `-` ersetzt. `/` wird NICHT als Hierarchie
 * durchgereicht, sondern ebenfalls ersetzt: Git kann in seinem Ref-Namensraum
 * keinen Ref gleichzeitig als "Datei" (`draft/a`) und "Verzeichnis"
 * (`draft/a/b`) führen — ein zweistufiges `draft/<sanitized>` ohne
 * verschachtelte Slashes umgeht dieses Problem von vornherein.
 *
 * Kollisionsschutz: sobald irgendein Zeichen ersetzt wurde (`changed`), hängt
 * die Funktion einen 8-Zeichen-SHA-256-Suffix des vollständigen,
 * UN-sanitizten `pageId` an. Zwei verschiedene Ids, die auf denselben Slug
 * abbilden (z. B. `"a b"` und `"a:b"` → beide `"a-b"`), erhalten dadurch
 * unterschiedliche Suffixe und bleiben als Branch-Namen unterscheidbar. Ids,
 * die bereits vollständig git-sicher sind, bleiben unverändert (kein
 * Suffix) — das entspricht dem in Plan/Kommentaren dokumentierten Normalfall
 * `draft/<pageId>` für "normale" (bereits sichere) Ids.
 */

const ALLOWED_CHAR = /[a-z0-9._-]/
const HASH_SUFFIX_LENGTH = 8
/** Fallback-Slug, falls nach dem Sanitizing/Trimmen nichts Verwendbares übrig bleibt
 *  (z. B. eine Id, die ausschließlich aus nicht erlaubten Zeichen besteht). */
const EMPTY_SLUG_FALLBACK = 'page'

interface SanitizeResult {
  slug: string
  /** true, wenn IRGENDEINE Abweichung vom Original vorliegt (ersetztes Zeichen,
   *  entfernte führende/folgende Trenner, oder der Empty-Fallback) — löst den
   *  Hash-Suffix aus. */
  changed: boolean
}

function sanitize(pageId: string): SanitizeResult {
  let changed = false
  let slug = ''
  for (const ch of pageId) {
    if (ALLOWED_CHAR.test(ch)) {
      slug += ch
    } else {
      slug += '-'
      changed = true
    }
  }

  // Kosmetisch: mehrfache Bindestriche zusammenfassen. Ändert die
  // Kollisionssicherheit nicht (der Hash-Suffix hängt immer am rohen,
  // unveränderten `pageId`, nicht am Slug).
  const collapsed = slug.replace(/-{2,}/g, '-')
  if (collapsed !== slug) changed = true
  slug = collapsed

  // Git verbietet u. a. Ref-Komponenten, die mit '.' beginnen, und
  // Ref-Namen, die auf '.'/'-' "ausfransen" — führende/folgende '.'/'-' kappen.
  const trimmed = slug.replace(/^[.-]+/, '').replace(/[.-]+$/, '')
  if (trimmed !== slug) changed = true
  slug = trimmed

  if (slug.length === 0) {
    slug = EMPTY_SLUG_FALLBACK
    changed = true
  }

  return { slug, changed }
}

/**
 * Liefert den deterministischen, git-sicheren Draft-Branch-Namen für eine
 * Seiten-Id: `draft/<slug>` (unverändert, wenn `pageId` bereits vollständig
 * git-sicher ist) oder `draft/<slug>-<sha256-8>` (sobald irgendeine
 * Ersetzung nötig war — Kollisionsschutz, siehe Modul-Kommentar). Wird auch
 * von Phase 2d (Review-PR) für denselben Branch benötigt, daher exportiert.
 */
export function draftBranchName(pageId: string): string {
  if (pageId.length === 0) {
    throw new Error('draftBranchName: pageId darf nicht leer sein.')
  }

  const { slug, changed } = sanitize(pageId)
  if (!changed) return `draft/${slug}`

  const hash = createHash('sha256').update(pageId, 'utf8').digest('hex').slice(0, HASH_SUFFIX_LENGTH)
  return `draft/${slug}-${hash}`
}
