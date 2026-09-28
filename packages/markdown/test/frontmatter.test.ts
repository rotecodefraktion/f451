import { describe, expect, it } from 'vitest'
import { parseFrontmatterBlock } from '../src/frontmatter.js'

describe('Frontmatter-Validierung', () => {
  it('parst vollständiges, gültiges Frontmatter', () => {
    const { frontmatter, errors } = parseFrontmatterBlock(
      [
        'id: 8f3ka2',
        'title: Deployment',
        'tags: [betrieb, kubernetes]',
        'lang: de',
        'relations:',
        '  depends_on: [betrieb/monitoring]',
        'archived: false',
      ].join('\n'),
    )
    expect(errors).toEqual([])
    expect(frontmatter).toEqual({
      id: '8f3ka2',
      title: 'Deployment',
      tags: ['betrieb', 'kubernetes'],
      lang: 'de',
      relations: { depends_on: ['betrieb/monitoring'] },
      archived: false,
    })
  })

  it('meldet falsche Typen als Fehler, wirft aber nie', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('id: 123\ntags: kubernetes\ntitle: X')
    expect(errors).toContain('id: muss ein String sein')
    expect(errors).toContain('tags: muss eine Liste von Strings sein')
    expect(frontmatter.title).toBe('X')
    expect(frontmatter.id).toBeUndefined()
    expect(frontmatter.tags).toEqual([])
  })

  it('meldet unbekannte Relations-Typen, behält bekannte', () => {
    const { frontmatter, errors } = parseFrontmatterBlock(
      'relations:\n  depends_on: [a]\n  kaputt_zu: [b]',
    )
    expect(errors).toContain('relations: unbekannter Typ "kaputt_zu"')
    expect(frontmatter.relations).toEqual({ depends_on: ['a'] })
  })

  it('ignoriert unbekannte Top-Level-Felder ohne Fehler (Interop)', () => {
    const { errors } = parseFrontmatterBlock('title: X\naliases: [alt-name]')
    expect(errors).toEqual([])
  })

  it('meldet YAML-Syntaxfehler als einzelnen Fehler mit leerem Frontmatter', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('title: [kaputt')
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatch(/YAML/)
    expect(frontmatter).toEqual({ tags: [], relations: {} })
  })

  it('meldet Nicht-Objekt-Toplevel (Liste) als Fehler mit leerem Frontmatter', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('- a\n- b')
    expect(errors).toContain('Frontmatter: muss ein Objekt sein')
    expect(frontmatter).toEqual({ tags: [], relations: {} })
  })

  it('meldet Nicht-Objekt-Toplevel (Skalar) als Fehler mit leerem Frontmatter', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('nur ein string')
    expect(errors).toContain('Frontmatter: muss ein Objekt sein')
    expect(frontmatter).toEqual({ tags: [], relations: {} })
  })

  it('leerer String oder null als Toplevel ist kein Fehler (leeres Frontmatter)', () => {
    expect(parseFrontmatterBlock('').errors).toEqual([])
    expect(parseFrontmatterBlock('null').errors).toEqual([])
    expect(parseFrontmatterBlock('""').errors).toEqual([])
  })

  it('erlaubt konfigurierte zusätzliche Relations-Typen', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('relations:\n  replaces: [x]', {
      relationTypes: ['replaces'],
    })
    expect(errors).toEqual([])
    expect(frontmatter.relations).toEqual({ replaces: ['x'] })
  })

  it('liest description als String', () => {
    const { frontmatter, errors } = parseFrontmatterBlock(
      'title: Meeting-Notiz\ndescription: Gerüst für Besprechungsnotizen',
    )
    expect(errors).toEqual([])
    expect(frontmatter.description).toBe('Gerüst für Besprechungsnotizen')
  })

  it('meldet description mit falschem Typ als Fehler, Feld bleibt undefined', () => {
    const { frontmatter, errors } = parseFrontmatterBlock('description: [a, b]')
    expect(errors).toContain('description: muss ein String sein')
    expect(frontmatter.description).toBeUndefined()
  })

  describe('Metadaten (Feature M1, _meta/schema.yaml)', () => {
    it('behält unbekannte Top-Level-Felder als metadata, statt sie zu verwerfen', () => {
      const { frontmatter, errors } = parseFrontmatterBlock(
        [
          'title: SAP-Prozess',
          'process_id: SAP-P-0042',
          'business_unit: Einkauf',
          'approved_by: jdoe',
        ].join('\n'),
      )
      expect(errors).toEqual([])
      expect(frontmatter.metadata).toEqual({
        process_id: 'SAP-P-0042',
        business_unit: 'Einkauf',
        approved_by: 'jdoe',
      })
    })

    it('metadata bleibt undefined, wenn keine zusätzlichen Felder vorkommen (bestehende Seiten unverändert)', () => {
      const { frontmatter } = parseFrontmatterBlock('id: 8f3ka2\ntitle: Deployment\ntags: [betrieb]')
      expect(frontmatter.metadata).toBeUndefined()
    })

    it('bekannte Felder (id/title/tags/lang/relations/archived) bleiben unverändert, auch mit Metadaten daneben', () => {
      const { frontmatter, errors } = parseFrontmatterBlock(
        [
          'id: 8f3ka2',
          'title: Deployment',
          'tags: [betrieb]',
          'lang: de',
          'archived: false',
          'relations:',
          '  depends_on: [monitoring]',
          'process_id: SAP-P-0042',
        ].join('\n'),
      )
      expect(errors).toEqual([])
      expect(frontmatter).toEqual({
        id: '8f3ka2',
        title: 'Deployment',
        tags: ['betrieb'],
        lang: 'de',
        archived: false,
        relations: { depends_on: ['monitoring'] },
        metadata: { process_id: 'SAP-P-0042' },
      })
    })

    it('erhält beliebige YAML-Werttypen (Zahl, Boolean, Liste) roh in metadata', () => {
      const { frontmatter, errors } = parseFrontmatterBlock(
        'review_count: 3\nurgent: true\nreviewers: [alice, bob]',
      )
      expect(errors).toEqual([])
      expect(frontmatter.metadata).toEqual({ review_count: 3, urgent: true, reviewers: ['alice', 'bob'] })
    })

    it('kein metadata bei ungültigem (Nicht-Objekt-)Toplevel', () => {
      const { frontmatter } = parseFrontmatterBlock('- a\n- b')
      expect(frontmatter.metadata).toBeUndefined()
    })
  })

  describe('Versionsfelder', () => {
    it('parst version und changelog als Kernfelder', () => {
      const { frontmatter, errors } = parseFrontmatterBlock(
        [
          'title: Handbuch',
          'version: 1.2.0',
          'changelog:',
          '  - version: 1.2.0',
          '    date: 2026-07-19',
          '    author: David Krcek',
          '    note: Rate-Limits ergänzt',
        ].join('\n'),
      )

      expect(errors).toEqual([])
      expect(frontmatter.version).toBe('1.2.0')
      expect(frontmatter.changelog).toEqual([
        { version: '1.2.0', date: '2026-07-19', author: 'David Krcek', note: 'Rate-Limits ergänzt' },
      ])
      // Kernfelder dürfen NICHT zusätzlich unter metadata landen.
      expect(frontmatter.metadata).toBeUndefined()
    })

    it('lässt beide Felder undefined, wenn sie fehlen', () => {
      const { frontmatter } = parseFrontmatterBlock('title: Handbuch')
      expect(frontmatter.version).toBeUndefined()
      expect(frontmatter.changelog).toBeUndefined()
    })

    it('verwirft eine unbrauchbare version fail-soft mit Fehlermeldung', () => {
      const { frontmatter, errors } = parseFrontmatterBlock('version: 17')
      expect(frontmatter.version).toBeUndefined()
      expect(errors).toContain('version: muss eine Zeichenkette sein')
    })

    it('akzeptiert einen Eintrag ohne Notiz (Freigabe ohne Kommentar)', () => {
      // Die Freigabe-Route schreibt bei fehlendem Kommentar `note: ""` — der
      // Parser darf den Eintrag deswegen nicht verwerfen (sonst trägt die Seite
      // dauerhaft einen Verarbeitungsfehler, den niemand beheben kann:
      // version/changelog sind systemverwaltet und im Editor nicht änderbar).
      const { frontmatter, errors } = parseFrontmatterBlock(
        [
          'changelog:',
          '  - version: 1.2.0',
          '    date: 2026-07-25',
          '    author: David Krcek',
          '    note: ""',
          '  - version: 1.1.0',
          '    date: 2026-06-02',
          '    author: David Krcek',
        ].join('\n'),
      )

      expect(errors).toEqual([])
      expect(frontmatter.changelog).toEqual([
        { version: '1.2.0', date: '2026-07-25', author: 'David Krcek', note: '' },
        { version: '1.1.0', date: '2026-06-02', author: 'David Krcek', note: '' },
      ])
    })

    it('überspringt kaputte changelog-Einträge, behält die gültigen', () => {
      const { frontmatter, errors } = parseFrontmatterBlock(
        [
          'changelog:',
          '  - version: 1.1.0',
          '    date: 2026-06-02',
          '    author: D. Krcek',
          '    note: Kapitel neu',
          '  - nur-müll: ja',
        ].join('\n'),
      )

      expect(frontmatter.changelog).toEqual([
        { version: '1.1.0', date: '2026-06-02', author: 'D. Krcek', note: 'Kapitel neu' },
      ])
      expect(errors.some((e) => e.startsWith('changelog['))).toBe(true)
    })
  })
})
