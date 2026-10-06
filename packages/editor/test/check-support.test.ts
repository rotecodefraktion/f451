import { describe, expect, it, vi } from 'vitest'
import { checkEditorSupport } from '../src/check-support.js'

// --- Tests für checkEditorSupport (Task 5, Phase 2b) -------------------------------
//
// Ein Fall pro Finding-Kind (Brief-Vorgabe) plus die Kombinationsfälle, die den
// canEdit-Vertrag beweisen: 'unsupported' dominiert IMMER (canEdit false, Roh-Modus
// bleibt möglich), 'normalization'/'frontmatter' allein lassen canEdit true. Reine
// Modellebene: kein DOM, kein jsdom — checkEditorSupport ruft nur @f451/markdown und
// die anderen Editor-Module (from-markdown/to-markdown) auf.

// --- Robustheitsgurt (Final-Review Phase 2b) ---------------------------------------
//
// markdownToDoc/docToMarkdown sind nach dem I2-Fix für jedes bekannte, valide Markdown
// crashfrei — es gibt also keinen NATÜRLICHEN Input mehr, der den Roundtrip in
// checkEditorSupport zum Werfen bringt. Der try/catch in check-support.ts ist deshalb
// rein defensiv (künftige, heute unbekannte Konstrukte). Um den catch-Pfad trotzdem
// unit-artig zu beweisen, wird markdownToDoc gezielt gemockt (vi.mock mit
// importOriginal, alle anderen Exporte bleiben echt) — kein Umbau der Architektur von
// check-support.ts nötig, nur dieser eine Testfall bekommt einen präparierten,
// künstlich werfenden markdownToDoc.
vi.mock('../src/from-markdown.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/from-markdown.js')>()
  return {
    ...actual,
    markdownToDoc: (body: string) => {
      if (body === 'ROUNDTRIP-CRASH-SIMULATION\n') {
        throw new Error('simulierter unerwarteter Strukturfehler (Test-Doppelgänger)')
      }
      return actual.markdownToDoc(body)
    },
  }
})

describe('checkEditorSupport', () => {
  it('kanonisches Dokument: keine Findings, canEdit true, kein canonicalBody', () => {
    const report = checkEditorSupport('# Titel\n\nEin Absatz mit **fett** und *kursiv*.\n')
    expect(report).toEqual({ canEdit: true, findings: [] })
  })

  it('zwei rohe HTML-Blöcke: canEdit false, VOLLSTÄNDIGE Befundliste mit Zeilen', () => {
    const markdown = 'Vorher.\n\n<div>Erster Block</div>\n\nMitte.\n\n<div>Zweiter Block</div>\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(false)
    expect(report.canonicalBody).toBeUndefined()
    expect(report.findings).toHaveLength(2)
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'unsupported', nodeType: 'html', line: 3 }),
      expect.objectContaining({ kind: 'unsupported', nodeType: 'html', line: 7 }),
    ])
    // Jeder Fund trägt eine sprechende Meldung (Nutzer-Feedback, s. README).
    for (const finding of report.findings) {
      expect(finding.message).toContain('html')
    }
  })

  it('nicht-kanonisches, aber unterstütztes Dokument: normalization-Finding + roundtrip-stabiles canonicalBody', () => {
    // '*'-Bullets sind unterstützt, aber nicht kanonisch (Kanon: '-', s. stringify.ts) —
    // der Roundtrip normalisiert sie, ohne dass ein Knoten unabbildbar wäre.
    const markdown = '* Erster Punkt\n* Zweiter Punkt\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(true)
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'normalization', message: expect.stringContaining('normalisiert') }),
    ])
    expect(report.canonicalBody).toBe('- Erster Punkt\n- Zweiter Punkt\n')

    // Zweitprüfung: canonicalBody selbst ist bereits die kanonische Form — erneutes
    // Prüfen liefert KEINE Findings mehr (Roundtrip-stabil, kein zweiter Normalisierungs-
    // Schritt nötig).
    const second = checkEditorSupport(report.canonicalBody!)
    expect(second).toEqual({ canEdit: true, findings: [] })
  })

  it('Frontmatter-Schemafehler: frontmatter-Finding, canEdit bleibt true', () => {
    const markdown = '---\ntags: kein-array\n---\n# Titel\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(true)
    expect(report.canonicalBody).toBeUndefined()
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'frontmatter', message: expect.stringContaining('tags') }),
    ])
  })

  it('Kombination: unsupported + frontmatter gleichzeitig -> canEdit false, beide Findings vorhanden', () => {
    const markdown = '---\ntags: kein-array\n---\n<div>x</div>\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(false)
    expect(report.canonicalBody).toBeUndefined()
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'frontmatter' }),
        expect.objectContaining({ kind: 'unsupported', nodeType: 'html' }),
      ]),
    )
    expect(report.findings).toHaveLength(2)
  })

  it('Dokument mit Frontmatter ohne Fehler und kanonischem Body: keine Findings', () => {
    const markdown = '---\ntitle: Betriebshandbuch\ntags: [betrieb]\n---\n# Titel\n\nText.\n'
    const report = checkEditorSupport(markdown)
    expect(report).toEqual({ canEdit: true, findings: [] })
  })

  // --- Randfälle (Review-Auflage Fix-Runde 1) ---------------------------------------

  it('leeres Dokument: keine Findings, canEdit true, kein canonicalBody', () => {
    expect(checkEditorSupport('')).toEqual({ canEdit: true, findings: [] })
  })

  it('nur valides Frontmatter ohne Body: keine Findings (weder unsupported noch normalization)', () => {
    const markdown = '---\ntitle: Betriebshandbuch\ntags: [betrieb]\n---\n'
    const report = checkEditorSupport(markdown)
    expect(report).toEqual({ canEdit: true, findings: [] })
  })

  it('Frontmatter-Schemafehler + nicht-kanonischer Body: BEIDE Finding-Kinds, canonicalBody gesetzt und stabil', () => {
    const markdown = '---\ntags: kein-array\n---\n* Erster Punkt\n* Zweiter Punkt\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(true)
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'frontmatter', message: expect.stringContaining('tags') }),
      expect.objectContaining({ kind: 'normalization', message: expect.stringContaining('normalisiert') }),
    ])
    // canonicalBody ist NUR der Body (ohne Frontmatter), in kanonischer Form.
    expect(report.canonicalBody).toBe('- Erster Punkt\n- Zweiter Punkt\n')

    // Zweitprüfung: der kanonische Body allein liefert keine Findings mehr
    // (roundtrip-stabil — insbesondere kein erneutes normalization-Finding).
    expect(checkEditorSupport(report.canonicalBody!)).toEqual({ canEdit: true, findings: [] })
  })

  it('nur Frontmatter mit Schemafehler (ohne Body): genau ein frontmatter-Finding, canEdit true', () => {
    const markdown = '---\ntags: kein-array\n---\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(true)
    expect(report.canonicalBody).toBeUndefined()
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'frontmatter', message: expect.stringContaining('tags') }),
    ])
  })

  // --- Robustheitsgurt: unerwarteter Strukturfehler im Roundtrip -------------------

  it('unerwarteter Fehler im markdownToDoc/docToMarkdown-Roundtrip: Report statt Exception (canEdit false)', () => {
    const markdown = 'ROUNDTRIP-CRASH-SIMULATION\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(false)
    expect(report.canonicalBody).toBeUndefined()
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'unsupported',
        message: expect.stringContaining('simulierter unerwarteter Strukturfehler'),
      }),
    ])
  })

  it('unerwarteter Roundtrip-Fehler KOMBINIERT mit Frontmatter-Finding: beide Findings, canEdit false', () => {
    const markdown = '---\ntags: kein-array\n---\nROUNDTRIP-CRASH-SIMULATION\n'
    const report = checkEditorSupport(markdown)

    expect(report.canEdit).toBe(false)
    expect(report.canonicalBody).toBeUndefined()
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'frontmatter' }),
        expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining('Strukturfehler') }),
      ]),
    )
    expect(report.findings).toHaveLength(2)
  })
})
