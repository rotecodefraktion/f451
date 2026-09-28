import { describe, expect, it } from 'vitest'
import { gitBlobSha1 } from '../src/drafts/blob-sha.js'

/**
 * `gitBlobSha1` (Fix Review-Befund 3, Task 2a-3): deterministische
 * Blob-SHA-Berechnung aus dem gespeicherten Inhalt statt eines nachgelagerten
 * `readFile`, das anfällig für eine Race mit einem zwischenzeitlich fremden
 * Commit wäre (siehe Kommentar in `src/drafts/blob-sha.ts`). Vergleichswerte
 * mit `git hash-object --stdin` ermittelt (bekannter leerer-String-Wert aus
 * dem Review-Befund sowie ein selbst nachgerechneter Mehrbyte-Fixture-Wert).
 */
describe('gitBlobSha1 (Fix Review-Befund 3, Task 2a-3)', () => {
  it('leerer Inhalt → bekannter git hash-object-Wert', () => {
    expect(gitBlobSha1('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })

  it('Mehrbyte-Inhalt (Umlaute): SHA über die UTF-8-Bytes, nicht die Zeichenanzahl', () => {
    // Vergleichswert lokal ermittelt: `printf '%s' 'Über äöü' | git hash-object --stdin`
    expect(gitBlobSha1('Über äöü')).toBe('31127a894d6b553103748a2787234da41f3dee1f')
  })

  it('einfacher ASCII-Inhalt → bekannter git hash-object-Wert', () => {
    // `printf '%s' 'hello world' | git hash-object --stdin`
    expect(gitBlobSha1('hello world')).toBe('95d09f2b10159347eece71399a7e2e907ea3df4f')
  })
})
