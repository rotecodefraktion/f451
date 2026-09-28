/** GitHub-Stil Slug: lowercase, Satzzeichen raus (Buchstaben/Ziffern/Leerzeichen/Bindestrich
 *  bleiben erhalten — Unicode-bewusst über \p{L}/\p{N}, damit Umlaute/ß und andere
 *  nicht-lateinische Buchstaben nicht verworfen werden), jedes Leerzeichen einzeln -> '-'
 *  (kein Kollabieren mehrerer Leerzeichen zu einem Bindestrich — GitHub macht das
 *  zeichenweise, z.B. "x  y" -> "x--y").
 *  Einzige Slug-Quelle im Paket — wird sowohl von parsePage (ToC-Slugs) als auch vom
 *  Rendering (HTML-IDs, Task 3) genutzt, damit beide Seiten übereinstimmen. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')
}

/** Erzeugt einen Slugger-Funktion mit per-Instanz-Counter für eindeutige Slugs innerhalb
 *  eines Dokuments: doppelte Headings ("Setup", "Setup") ergeben "setup", "setup-1",
 *  "setup-2", ... Jeder Aufruf von parsePage bzw. jedes renderHtml-Rendering erzeugt eine
 *  frische Instanz, damit Slugs nicht dokumentübergreifend kollidieren oder sich
 *  aufsummieren — ToC-Slugs (parsePage) und HTML-IDs (renderHtml) bleiben dadurch
 *  identisch, solange die Heading-Reihenfolge gleich ist. */
export function createSlugger(): (text: string) => string {
  const counts = new Map<string, number>()
  return (text: string) => {
    const base = slugify(text)
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}
