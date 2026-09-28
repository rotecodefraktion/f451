import { describe, expect, it } from 'vitest'
import { checkEditorSupport } from '@f451/editor'
import { frontmatterLineOffset, offsetFindingLines } from './frontmatter-offset.js'

describe('frontmatterLineOffset', () => {
  it('liefert 0 ohne Frontmatter', () => {
    expect(frontmatterLineOffset('# Titel\n\nText.\n')).toBe(0)
  })

  it('liefert 0 für ein leeres Dokument', () => {
    expect(frontmatterLineOffset('')).toBe(0)
  })

  it('zählt die Zäunen-Zeilen bei einzeiligem Frontmatter', () => {
    // Dokumentzeilen: 1 "---", 2 "title: x", 3 "---", 4 "Body." — Body-Zeile 1
    // liegt auf Dokumentzeile 4, der Offset muss also 3 sein.
    const md = '---\ntitle: x\n---\nBody.\n'
    expect(frontmatterLineOffset(md)).toBe(3)
  })

  it('zählt korrekt bei mehrzeiligem Frontmatter (Listen-Werte)', () => {
    // Dokumentzeilen: 1 "---", 2 "title: x", 3 "tags:", 4 "  - a", 5 "  - b",
    // 6 "---", 7 "Body." — Offset muss 6 sein.
    const md = '---\ntitle: x\ntags:\n  - a\n  - b\n---\nBody.\n'
    expect(frontmatterLineOffset(md)).toBe(6)
  })

  it('zählt korrekt bei Windows-Zeilenenden (CRLF)', () => {
    // splitFrontmatter erkennt \r\n als abschließenden Zeilenumbruch (s.
    // packages/markdown/src/frontmatter-split.ts) — Dokumentzeilen: 1 "---",
    // 2 "title: x", 3 "tags:", 4 "  - a", 5 "---", 6 "Body." — Offset muss 5
    // sein (jedes \r\n zählt als eine Zeile, wie \n im LF-Fall oben).
    const md = '---\r\ntitle: x\r\ntags:\r\n  - a\r\n---\r\nBody.\r\n'
    expect(frontmatterLineOffset(md)).toBe(5)
  })
})

describe('offsetFindingLines', () => {
  it('lässt Befunde ohne Zeile (frontmatter/normalization) unverändert', () => {
    const findings = [{ kind: 'frontmatter' as const, message: 'x' }, { kind: 'normalization' as const, message: 'y' }]
    expect(offsetFindingLines(findings, 5)).toEqual(findings)
  })

  it('addiert den Offset nur auf Befunde MIT Zeile', () => {
    const findings = [
      { kind: 'unsupported' as const, message: 'x', line: 3, nodeType: 'html' },
      { kind: 'frontmatter' as const, message: 'y' },
    ]
    expect(offsetFindingLines(findings, 4)).toEqual([
      { kind: 'unsupported', message: 'x', line: 7, nodeType: 'html' },
      { kind: 'frontmatter', message: 'y' },
    ])
  })

  it('gibt bei Offset 0 ein Ergebnis mit denselben Werten zurück', () => {
    const findings = [{ kind: 'unsupported' as const, message: 'x', line: 3, nodeType: 'html' }]
    expect(offsetFindingLines(findings, 0)).toEqual(findings)
  })
})

// --- Regressionstest: volle Dokumentzeile nach Offset entspricht der echten
// Fundstelle im Volldokument (Kern des Critical-Befunds) --------------------
describe('Regression: finding.line + frontmatterLineOffset zeigt auf die echte Dokumentzeile', () => {
  it('rohes HTML nach mehrzeiligem Frontmatter', () => {
    const md = '---\ntitle: x\ntags:\n  - a\n---\n# Titel\n\n<div>raw html</div>\n'
    const report = checkEditorSupport(md)
    const offset = frontmatterLineOffset(md)
    const findings = offsetFindingLines(report.findings, offset)

    expect(report.canEdit).toBe(false)
    expect(findings).toHaveLength(1)
    // Dokumentzeilen: 1 "---" .. 5 "---", 6 "# Titel", 7 "", 8 "<div>...".
    expect(findings[0].line).toBe(8)
    expect(md.split('\n')[7]).toBe('<div>raw html</div>')
  })

  it('ohne Frontmatter bleibt die Zeile unverändert (Offset 0)', () => {
    const md = '# Titel\n\n<div>raw html</div>\n'
    const report = checkEditorSupport(md)
    const findings = offsetFindingLines(report.findings, frontmatterLineOffset(md))

    expect(findings[0].line).toBe(3)
    expect(md.split('\n')[2]).toBe('<div>raw html</div>')
  })
})
