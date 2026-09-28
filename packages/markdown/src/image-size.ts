// --- Obsidian-Bildgröße im Alt-Text: `![Alt|400](url)` / `![Alt|400x300](url)` -------
//
// EINE Quelle der Wahrheit für die Breiten-Syntax, gemeinsam genutzt von der
// Lese-Pipeline (`render.ts`) UND dem Editor-Roundtrip (`@f451/editor`
// from-/to-markdown). `parseImageAltSize`/`formatImageAlt` sind EXAKTE Inverse —
// das ist Bedingung für die „Markdown-Wahrheit" (byte-identischer Roundtrip,
// s. stringify.ts): bewusst KEINE Whitespace-Bereinigung des Alt-Teils, sonst
// verlöre `![Alt |400]` beim Zurückschreiben das Leerzeichen.

export interface ImageAltSize {
  /** Alt-Text OHNE das `|…`-Größensuffix (verbatim, nicht getrimmt). */
  alt: string
  /** Breite in px (Pflicht, sonst wäre es kein Größensuffix). */
  width: number
  /** Höhe in px, nur wenn `|WxH` angegeben war. */
  height?: number
}

/** Liest ein abschließendes `|400` bzw. `|400x300` aus dem Alt-Text. Der Teil vor
 *  dem LETZTEN `|` bleibt Alt-Text (greedy — das letzte `|` gewinnt). null, wenn
 *  kein gültiges Größensuffix vorliegt (z. B. `![a|b]`, `|` ohne Ziffern). */
export function parseImageAltSize(alt: string | null | undefined): ImageAltSize | null {
  if (typeof alt !== 'string') return null
  const match = /^(.*)\|(\d+)(?:x(\d+))?$/s.exec(alt)
  if (!match) return null
  const height = match[3] !== undefined ? Number(match[3]) : undefined
  return { alt: match[1], width: Number(match[2]), height }
}

/** Inverse zu {@link parseImageAltSize}: hängt die Maße als `|W` bzw. `|WxH` an den
 *  Alt-Text. Ohne `width` bleibt der Alt-Text unverändert (kein Suffix). */
export function formatImageAlt(
  alt: string | null | undefined,
  width?: number | null,
  height?: number | null,
): string {
  const base = alt ?? ''
  if (!width) return base
  return height ? `${base}|${width}x${height}` : `${base}|${width}`
}
