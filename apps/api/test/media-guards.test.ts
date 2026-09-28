import { describe, expect, it } from 'vitest'
import { buildContentDisposition, extensionOf, isSafeWildcard } from '../src/routes/media.js'

/**
 * Reine Funktions-Tests der Media-Route-Helfer, OHNE HTTP-Layer: `app.inject()`
 * (light-my-request) normalisiert übergebene URLs über den WHATWG-`URL`-
 * Konstruktor, der `..`-Segmente bereits vor dem Routing entfernt — ein echter
 * HTTP-Request mit rohem, nicht normalisiertem Request-Target (z. B. von einem
 * Skript, das nicht die üblichen Client-Normalisierungsregeln befolgt) erreicht
 * den Handler dagegen sehr wohl mit einem literalen `..` im Wildcard. Diese
 * Tests decken daher den Traversal-Schutz unabhängig vom Test-Harness ab.
 */
describe('isSafeWildcard (Traversal-Schutz)', () => {
  it('akzeptiert normale, auch verschachtelte Pfade', () => {
    expect(isSafeWildcard('logo.png')).toBe(true)
    expect(isSafeWildcard('foo/bar.png')).toBe(true)
    expect(isSafeWildcard('a/b/c.svg')).toBe(true)
  })

  it('lehnt ein ".."-Segment ab (Traversal)', () => {
    expect(isSafeWildcard('..')).toBe(false)
    expect(isSafeWildcard('../secret.md')).toBe(false)
    expect(isSafeWildcard('foo/../../secret.md')).toBe(false)
    expect(isSafeWildcard('foo/..')).toBe(false)
  })

  it('lehnt ein "."-Segment ab', () => {
    expect(isSafeWildcard('.')).toBe(false)
    expect(isSafeWildcard('./logo.png')).toBe(false)
  })

  it('lehnt leere Segmente ab (Doppel-Slash)', () => {
    expect(isSafeWildcard('')).toBe(false)
    expect(isSafeWildcard('foo//bar.png')).toBe(false)
  })
})

describe('extensionOf', () => {
  it('liefert die kleingeschriebene Extension des letzten Segments', () => {
    expect(extensionOf('logo.PNG')).toBe('png')
    expect(extensionOf('a/b/photo.JPG')).toBe('jpg')
  })

  it('liefert einen leeren String ohne Extension', () => {
    expect(extensionOf('a/b/README')).toBe('')
  })
})

describe('buildContentDisposition (Datei-Anhänge: Content-Disposition mit filename)', () => {
  it('setzt attachment + filename (ASCII) + filename* (RFC 5987) für einen einfachen Namen', () => {
    expect(buildContentDisposition('betriebshandbuch.pdf')).toBe(
      'attachment; filename="betriebshandbuch.pdf"; filename*=UTF-8\'\'betriebshandbuch.pdf',
    )
  })

  it('kodiert Nicht-ASCII-Zeichen im filename*-Teil, ersetzt sie im ASCII-Fallback', () => {
    const result = buildContentDisposition('Übersicht.xlsx')
    expect(result).toContain('filename*=UTF-8\'\'%C3%9Cbersicht.xlsx')
    expect(result).toContain('filename="_bersicht.xlsx"')
  })

  it('escaped/entfernt Anführungszeichen und Backslashes aus dem ASCII-Fallback (kein Header-Bruch)', () => {
    const result = buildContentDisposition('a"b\\c.txt')
    expect(result).toContain('filename="a_b_c.txt"')
    // Der RFC-5987-Teil trägt den vollen Namen unverändert (nur prozentkodiert).
    expect(result).toContain(`filename*=UTF-8''${encodeURIComponent('a"b\\c.txt')}`)
  })
})
