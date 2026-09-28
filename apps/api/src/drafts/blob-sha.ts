import { createHash } from 'node:crypto'

/**
 * Berechnet den Git-Blob-SHA1 eines Inhalts deterministisch, OHNE eine
 * erneute Provider-Anfrage (Fix Review-Befund 3, Task 2a-3, `drafts/save.ts`).
 *
 * Git berechnet den Blob-SHA als `sha1("blob " + <Byte-Länge> + "\0" +
 * <Inhalt>)` über die UTF-8-kodierten Bytes (dieselbe Formel wie
 * `git hash-object`). Vorher las `saveDraft` den Stand nach einem
 * erfolgreichen `writeFile` ERNEUT vom Provider, um `newSha` zu bestimmen —
 * das ist eine Race: schreibt zwischen `writeFile` und diesem `readFile` ein
 * anderer Nutzer (z. B. ein paralleler Autosave), liefert das `readFile` den
 * SHA des FREMDEN Commits als `newSha` an den ursprünglichen Aufrufer zurück.
 * Dessen nächster Save passiert dann den billigen Vorab-Check (SHA "stimmt"
 * ja scheinbar) und überschreibt den fremden Inhalt kommentarlos — der
 * 409-Vertrag (Plan Global Constraints: „nie stiller Verlust") wäre damit
 * unterlaufen.
 *
 * Die deterministische Berechnung aus dem SELBST GESCHRIEBENEN `content`
 * schließt die Race aus: der SHA gehört garantiert zum eigenen Save,
 * unabhängig davon, was der Provider inzwischen sonst noch verarbeitet hat.
 */
export function gitBlobSha1(content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}
