// Language of an Office document, detected from its text (no AI): decides the
// language of the names the import generates for it.

import { franc } from 'franc-min'
import type { Lang } from './doc.js'

/** Enough text for a stable trigram profile; more only costs time. */
const MAX_CHARS = 20_000
/** Shorter text gives no reliable result. */
const MIN_LENGTH = 50

/** `de` for German text, `en` for any other recognised language, null when
 *  the text is too short or undetermined. */
export function detectLang(text: string): Lang | null {
  const sample = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
  const code = franc(sample, { minLength: MIN_LENGTH })
  if (code === 'und') return null
  return code === 'deu' ? 'de' : 'en'
}
