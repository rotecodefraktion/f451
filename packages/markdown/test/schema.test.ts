import { describe, expect, it } from 'vitest'
import {
  computeFillOnReleaseValues,
  parseMetadataSchema,
  parseMetadataSchemaFromValue,
  stringifyMetadataSchema,
} from '../src/schema.js'
import type { MetadataSchema } from '../src/schema.js'

/** Realistisches Beispiel-Schema (SAP-Prozess-Doku, Feature-Kontext M1) — deckt
 *  alle sieben Feldtypen ab. */
const sapSchemaYaml = `
fields:
  - key: process_id
    label: Process ID
    type: pattern
    pattern: '^SAP-P-\\d{4}$'
    patternHint: 'Format: SAP-P-0000'
    required: true
    order: 1
  - key: business_unit
    label: Business Unit
    type: enum
    options: [Einkauf, Logistik, Finanzen, HR]
    required: true
    order: 2
  - key: status
    label: Status
    type: enum
    options: [Entwurf, In Review, Freigegeben, Veraltet]
    order: 3
  - key: approved_by
    label: Approved by
    type: user
    order: 4
  - key: approval_date
    label: Approval date
    type: date
    order: 5
  - key: next_review
    label: Next review
    type: date
    order: 6
  - key: tag
    label: Tag
    type: multi
    order: 7
  - key: last_author
    label: Last author
    type: auto
    source: last_author
    order: 8
  - key: last_updated
    label: Last updated
    type: auto
    source: last_updated
    order: 9
`

describe('parseMetadataSchema', () => {
  it('parst ein vollständiges, gültiges SAP-Beispiel-Schema mit allen Feldtypen', () => {
    const { schema, errors } = parseMetadataSchema(sapSchemaYaml)
    expect(errors).toEqual([])
    expect(schema.fields.map((f) => f.key)).toEqual([
      'process_id', 'business_unit', 'status', 'approved_by',
      'approval_date', 'next_review', 'tag', 'last_author', 'last_updated',
    ])

    const processId = schema.fields[0]
    expect(processId).toEqual({
      key: 'process_id',
      label: 'Process ID',
      type: 'pattern',
      pattern: '^SAP-P-\\d{4}$',
      patternHint: 'Format: SAP-P-0000',
      required: true,
      order: 1,
    })

    const businessUnit = schema.fields[1]
    expect(businessUnit).toEqual({
      key: 'business_unit',
      label: 'Business Unit',
      type: 'enum',
      options: ['Einkauf', 'Logistik', 'Finanzen', 'HR'],
      required: true,
      order: 2,
    })

    const approvedBy = schema.fields[3]
    expect(approvedBy).toEqual({ key: 'approved_by', label: 'Approved by', type: 'user', order: 4 })

    const approvalDate = schema.fields[4]
    expect(approvalDate).toEqual({ key: 'approval_date', label: 'Approval date', type: 'date', order: 5 })

    const tag = schema.fields[6]
    expect(tag).toEqual({ key: 'tag', label: 'Tag', type: 'multi', order: 7, options: undefined })

    const lastAuthor = schema.fields[7]
    expect(lastAuthor).toEqual({
      key: 'last_author', label: 'Last author', type: 'auto', source: 'last_author', order: 8,
    })
  })

  it('text-Feld ohne Zusatzangaben ist gültig', () => {
    const { schema, errors } = parseMetadataSchema('fields:\n  - key: notiz\n    label: Notiz\n    type: text')
    expect(errors).toEqual([])
    expect(schema.fields).toEqual([{ key: 'notiz', label: 'Notiz', type: 'text' }])
  })

  it('multi-Feld mit fester Optionsliste ist gültig', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: tag\n    label: Tag\n    type: multi\n    options: [a, b]',
    )
    expect(errors).toEqual([])
    expect(schema.fields).toEqual([{ key: 'tag', label: 'Tag', type: 'multi', options: ['a', 'b'] }])
  })

  it('leere/fehlende Datei ergibt ein leeres Schema ohne Fehler', () => {
    expect(parseMetadataSchema('')).toEqual({ schema: { fields: [], versioning: false }, errors: [] })
    expect(parseMetadataSchema('null')).toEqual({ schema: { fields: [], versioning: false }, errors: [] })
  })

  it('Objekt ohne "fields"-Schlüssel ist ein gültiges, leeres Schema', () => {
    expect(parseMetadataSchema('title: Nicht relevant'))
      .toEqual({ schema: { fields: [], versioning: false }, errors: [] })
  })

  it('YAML-Syntaxfehler → leeres Schema mit einem Fehler, wirft nie', () => {
    const { schema, errors } = parseMetadataSchema('fields: [kaputt')
    expect(schema).toEqual({ fields: [], versioning: false })
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatch(/YAML/)
  })

  it('Nicht-Objekt-Toplevel (Liste) → Fehler, leeres Schema', () => {
    const { schema, errors } = parseMetadataSchema('- a\n- b')
    expect(schema).toEqual({ fields: [], versioning: false })
    expect(errors).toContain('Schema: muss ein Objekt sein')
  })

  it('"fields" ist kein Array → Fehler, leeres Schema', () => {
    const { schema, errors } = parseMetadataSchema('fields: kaputt')
    expect(schema).toEqual({ fields: [], versioning: false })
    expect(errors).toContain('fields: muss eine Liste sein')
  })

  it('unbekannter type → Eintrag wird übersprungen, andere bleiben erhalten (fail-soft)', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n'
        + '  - key: a\n    label: A\n    type: text\n'
        + '  - key: b\n    label: B\n    type: nonsense\n',
    )
    expect(schema.fields).toEqual([{ key: 'a', label: 'A', type: 'text' }])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('fields[1]')
  })

  it('fehlender key → Eintrag wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema('fields:\n  - label: Ohne Key\n    type: text\n')
    expect(schema.fields).toEqual([])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('"key"')
  })

  it('doppelter key → zweiter Eintrag wird übersprungen, erster bleibt', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n'
        + '  - key: dup\n    label: Erster\n    type: text\n'
        + '  - key: dup\n    label: Zweiter\n    type: text\n',
    )
    expect(schema.fields).toEqual([{ key: 'dup', label: 'Erster', type: 'text' }])
    expect(errors.some((e) => e.includes('bereits vergeben'))).toBe(true)
  })

  it(
    'key "version" (reservierter Frontmatter-Schlüssel seit der Seitenversionierung) wird '
      + 'übersprungen, Fehler nennt den Schlüssel (Befund 2, Final-Review)',
    () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n  - key: version\n    label: Version\n    type: text\n',
      )
      expect(schema.fields).toEqual([])
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('version')
      expect(errors[0]).toContain('reservierter Frontmatter-Schlüssel')
    },
  )

  it('key "changelog" (reservierter Frontmatter-Schlüssel) wird übersprungen (Befund 2, Final-Review)', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: changelog\n    label: Changelog\n    type: text\n',
    )
    expect(schema.fields).toEqual([])
    expect(errors.some((e) => e.includes('changelog') && e.includes('reservierter Frontmatter-Schlüssel'))).toBe(true)
  })

  it(
    'reservierter key in einem Eintrag verwirft nur diesen — andere gültige Felder bleiben '
      + 'erhalten (fail-soft, Befund 2, Final-Review)',
    () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n'
          + '  - key: process_id\n    label: Process ID\n    type: text\n'
          + '  - key: version\n    label: Version\n    type: text\n',
      )
      expect(schema.fields).toEqual([{ key: 'process_id', label: 'Process ID', type: 'text' }])
      expect(errors.length).toBe(1)
    },
  )

  it('fehlendes label → Feld bleibt erhalten, fällt auf key zurück, Fehler wird gemeldet', () => {
    const { schema, errors } = parseMetadataSchema('fields:\n  - key: ohne_label\n    type: text\n')
    expect(schema.fields).toEqual([{ key: 'ohne_label', label: 'ohne_label', type: 'text' }])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('label')
  })

  it('pattern-Feld ohne "pattern" wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema('fields:\n  - key: p\n    label: P\n    type: pattern\n')
    expect(schema.fields).toEqual([])
    expect(errors[0]).toContain('type "pattern" erfordert "pattern"')
  })

  it('pattern-Feld mit kaputtem regulärem Ausdruck wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: p\n    label: P\n    type: pattern\n    pattern: "[kaputt"\n',
    )
    expect(schema.fields).toEqual([])
    expect(errors[0]).toContain('kein gültiger regulärer Ausdruck')
  })

  it('enum-Feld ohne options wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema('fields:\n  - key: e\n    label: E\n    type: enum\n')
    expect(schema.fields).toEqual([])
    expect(errors[0]).toContain('type "enum" erfordert "options"')
  })

  it('enum-Feld mit leerer options-Liste wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: e\n    label: E\n    type: enum\n    options: []\n',
    )
    expect(schema.fields).toEqual([])
    expect(errors[0]).toContain('type "enum" erfordert "options"')
  })

  it('auto-Feld ohne bekannte source wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: a\n    label: A\n    type: auto\n    source: irgendwas\n',
    )
    expect(schema.fields).toEqual([])
    expect(errors[0]).toContain('type "auto" erfordert "source"')
  })

  it('Eintrag, der kein Objekt ist, wird übersprungen', () => {
    const { schema, errors } = parseMetadataSchema('fields:\n  - "nur ein string"\n')
    expect(schema.fields).toEqual([])
    expect(errors[0]).toContain('muss ein Objekt sein')
  })

  it('required mit falschem Typ → ignoriert (Feld bleibt, ohne required), Fehler gemeldet', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: a\n    label: A\n    type: text\n    required: "ja"\n',
    )
    expect(schema.fields).toEqual([{ key: 'a', label: 'A', type: 'text' }])
    expect(errors[0]).toContain('required')
  })

  it('order mit falschem Typ → ignoriert (Feld bleibt, ohne order), Fehler gemeldet', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n  - key: a\n    label: A\n    type: text\n    order: "eins"\n',
    )
    expect(schema.fields).toEqual([{ key: 'a', label: 'A', type: 'text' }])
    expect(errors[0]).toContain('order')
  })

  it('sortiert Felder nach "order" aufsteigend, unabhängig von der Reihenfolge in der Datei', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n'
        + '  - key: b\n    label: B\n    type: text\n    order: 2\n'
        + '  - key: a\n    label: A\n    type: text\n    order: 1\n',
    )
    expect(errors).toEqual([])
    expect(schema.fields.map((f) => f.key)).toEqual(['a', 'b'])
  })

  it('Felder ohne "order" behalten ihre Dateireihenfolge relativ zueinander', () => {
    const { schema, errors } = parseMetadataSchema(
      'fields:\n'
        + '  - key: erstes\n    label: Erstes\n    type: text\n'
        + '  - key: zweites\n    label: Zweites\n    type: text\n'
        + '  - key: drittes\n    label: Drittes\n    type: text\n',
    )
    expect(errors).toEqual([])
    expect(schema.fields.map((f) => f.key)).toEqual(['erstes', 'zweites', 'drittes'])
  })

  // Metadaten-Feature M3b Teil B: `fillOnRelease` auf `user`-/`date`-Feldern
  // (Freigabe-Vorbelegung, s. schema.ts-Modulkommentar bei `computeFillOnReleaseValues`).
  describe('fillOnRelease', () => {
    it('user-Feld mit fillOnRelease: actor ist gültig', () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n  - key: approved_by\n    label: Approved by\n    type: user\n    fillOnRelease: actor\n',
      )
      expect(errors).toEqual([])
      expect(schema.fields).toEqual([
        { key: 'approved_by', label: 'Approved by', type: 'user', fillOnRelease: 'actor' },
      ])
    })

    it('date-Feld mit fillOnRelease: date ist gültig', () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n  - key: approval_date\n    label: Approval date\n    type: date\n    fillOnRelease: date\n',
      )
      expect(errors).toEqual([])
      expect(schema.fields).toEqual([
        { key: 'approval_date', label: 'Approval date', type: 'date', fillOnRelease: 'date' },
      ])
    })

    it('user-Feld ohne fillOnRelease bleibt wie bisher (kein Schlüssel im Ergebnis)', () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n  - key: approved_by\n    label: Approved by\n    type: user\n',
      )
      expect(errors).toEqual([])
      expect(schema.fields).toEqual([{ key: 'approved_by', label: 'Approved by', type: 'user' }])
      expect('fillOnRelease' in schema.fields[0]!).toBe(false)
    })

    it('user-Feld mit falschem fillOnRelease-Wert → ignoriert, Feld bleibt sonst gültig, Fehler gemeldet', () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n  - key: approved_by\n    label: Approved by\n    type: user\n    fillOnRelease: date\n',
      )
      expect(schema.fields).toEqual([{ key: 'approved_by', label: 'Approved by', type: 'user' }])
      expect(errors[0]).toContain('fillOnRelease')
    })

    it('date-Feld mit falschem fillOnRelease-Wert → ignoriert, Feld bleibt sonst gültig, Fehler gemeldet', () => {
      const { schema, errors } = parseMetadataSchema(
        'fields:\n  - key: approval_date\n    label: Approval date\n    type: date\n    fillOnRelease: actor\n',
      )
      expect(schema.fields).toEqual([{ key: 'approval_date', label: 'Approval date', type: 'date' }])
      expect(errors[0]).toContain('fillOnRelease')
    })

    it('bestehende Schemas ohne fillOnRelease bleiben vollständig unberührt (SAP-Beispiel)', () => {
      const { schema, errors } = parseMetadataSchema(sapSchemaYaml)
      expect(errors).toEqual([])
      const approvedBy = schema.fields.find((f) => f.key === 'approved_by')!
      expect('fillOnRelease' in approvedBy).toBe(false)
    })
  })

  // Space-Schalter für die Seitenversionierung (Task 2, Etappe 1) — lebt im
  // selben `_meta/schema.yaml` wie die Feldtypen, ist aber unabhängig von
  // "fields" (ein Space kann versioniert sein, ohne eigene Metadatenfelder
  // zu deklarieren, s. Modulkommentar bei `parseMetadataSchemaFromValue`).
  describe('versioning-Schalter', () => {
    it('liest versioning: true', () => {
      const { schema, errors } = parseMetadataSchemaFromValue({ versioning: true, fields: [] })
      expect(schema.versioning).toBe(true)
      expect(errors).toEqual([])
    })

    it('ist ohne Angabe false', () => {
      const { schema } = parseMetadataSchemaFromValue({ fields: [] })
      expect(schema.versioning).toBe(false)
    })

    it('behält versioning, wenn gar keine fields deklariert sind', () => {
      // Ein Space kann versioniert sein, ohne eigene Metadatenfelder zu haben.
      const { schema } = parseMetadataSchemaFromValue({ versioning: true })
      expect(schema.versioning).toBe(true)
    })

    it('behält versioning, wenn fields kaputt ist', () => {
      const { schema, errors } = parseMetadataSchemaFromValue({ versioning: true, fields: 'kaputt' })
      expect(schema.versioning).toBe(true)
      expect(errors).toContain('fields: muss eine Liste sein')
    })

    it('meldet einen nicht-booleschen Wert und bleibt bei false', () => {
      const { schema, errors } = parseMetadataSchemaFromValue({ versioning: 'ja' })
      expect(schema.versioning).toBe(false)
      expect(errors).toContain('versioning: muss true oder false sein')
    })
  })
})

describe('computeFillOnReleaseValues', () => {
  const schema: MetadataSchema = {
    fields: [
      { key: 'approved_by', label: 'Approved by', type: 'user', fillOnRelease: 'actor' },
      { key: 'approval_date', label: 'Approval date', type: 'date', fillOnRelease: 'date' },
      { key: 'reviewer', label: 'Reviewer', type: 'user' },
      { key: 'process_id', label: 'Process ID', type: 'text' },
    ],
    versioning: false,
  }
  const values = { actor: 'Releaser', date: '2026-07-16' }

  it('leere fillOnRelease-Felder werden mit Nutzer/Datum vorbelegt', () => {
    expect(computeFillOnReleaseValues(schema, {}, values)).toEqual({
      approved_by: 'Releaser',
      approval_date: '2026-07-16',
    })
  })

  it('bereits gesetzter Wert bleibt unverändert (kein Überschreiben)', () => {
    const current = { approved_by: 'Alice', approval_date: '' }
    expect(computeFillOnReleaseValues(schema, current, values)).toEqual({
      approval_date: '2026-07-16',
    })
  })

  it('beide bereits gesetzt → leeres Ergebnis (nichts zu tun)', () => {
    const current = { approved_by: 'Alice', approval_date: '2026-01-01' }
    expect(computeFillOnReleaseValues(schema, current, values)).toEqual({})
  })

  it('Felder ohne fillOnRelease werden nie befüllt, auch wenn leer', () => {
    expect(computeFillOnReleaseValues(schema, {}, values)).not.toHaveProperty('reviewer')
    expect(computeFillOnReleaseValues(schema, {}, values)).not.toHaveProperty('process_id')
  })

  it('leeres Schema → leeres Ergebnis', () => {
    expect(computeFillOnReleaseValues({ fields: [], versioning: false }, {}, values)).toEqual({})
  })

  it('Whitespace-only-Wert gilt als leer und wird vorbelegt', () => {
    expect(computeFillOnReleaseValues(schema, { approved_by: '   ' }, values)).toEqual({
      approved_by: 'Releaser',
      approval_date: '2026-07-16',
    })
  })
})

// Metadaten-Feature M4 (Schema-Editor-UI): Gegenstück zu `parseMetadataSchema`
// — schreibt `_meta/schema.yaml` aus einem `MetadataSchema` zurück. Die
// zentrale Garantie ist der Roundtrip mit `parseMetadataSchema`: für jedes
// Schema, das der Parser selbst zurückgegeben hat (Felder bereits in
// `order`-Reihenfolge), muss `parseMetadataSchema(stringifyMetadataSchema(s)).schema`
// wieder exakt `s` ergeben — sonst würde der Schema-Editor beim bloßen
// Öffnen+Speichern (ohne Änderung) das Schema verfälschen.
describe('stringifyMetadataSchema', () => {
  it('Roundtrip: vollständiges SAP-Beispiel-Schema (alle neun Feldtypen/Zusatzangaben)', () => {
    const { schema: original, errors: parseErrors } = parseMetadataSchema(sapSchemaYaml)
    expect(parseErrors).toEqual([])

    const yamlText = stringifyMetadataSchema(original)
    const { schema: roundtripped, errors } = parseMetadataSchema(yamlText)

    expect(errors).toEqual([])
    expect(roundtripped).toEqual(original)
  })

  it('Roundtrip: versioning: true bleibt beim Schreiben/Lesen erhalten', () => {
    const original: MetadataSchema = { fields: [], versioning: true }
    const yamlText = stringifyMetadataSchema(original)
    expect(yamlText).toContain('versioning: true')
    const { schema, errors } = parseMetadataSchema(yamlText)
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('versioning: false wird NICHT in die YAML geschrieben (kein Rauschen bei unverändertem Schema)', () => {
    const original: MetadataSchema = { fields: [], versioning: false }
    const yamlText = stringifyMetadataSchema(original)
    expect(yamlText).not.toContain('versioning')
  })

  it('Roundtrip: leeres Schema', () => {
    const empty: MetadataSchema = { fields: [], versioning: false }
    const yamlText = stringifyMetadataSchema(empty)
    expect(parseMetadataSchema(yamlText)).toEqual({ schema: empty, errors: [] })
  })

  it('Roundtrip: text-Feld ohne Zusatzangaben', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'notiz', label: 'Notiz', type: 'text' }],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: pattern-Feld MIT patternHint', () => {
    const original: MetadataSchema = {
      fields: [
        {
          key: 'process_id',
          label: 'Process ID',
          type: 'pattern',
          pattern: '^SAP-P-\\d{4}$',
          patternHint: 'Format: SAP-P-0000',
          required: true,
        },
      ],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: pattern-Feld OHNE patternHint (Schlüssel taucht in der YAML nicht auf)', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'p', label: 'P', type: 'pattern', pattern: '^[a-z]+$' }],
      versioning: false,
    }
    const yamlText = stringifyMetadataSchema(original)
    expect(yamlText).not.toContain('patternHint')
    const { schema, errors } = parseMetadataSchema(yamlText)
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: enum-Feld', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'status', label: 'Status', type: 'enum', options: ['Entwurf', 'Freigegeben'] }],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: multi-Feld MIT fester Optionsliste', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'tag', label: 'Tag', type: 'multi', options: ['a', 'b'] }],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: multi-Feld OHNE Optionsliste (freie Tag-Eingabe, Schlüssel fehlt in der YAML)', () => {
    const original: MetadataSchema = { fields: [{ key: 'tag', label: 'Tag', type: 'multi' }], versioning: false }
    const yamlText = stringifyMetadataSchema(original)
    expect(yamlText).not.toContain('options')
    const { schema, errors } = parseMetadataSchema(yamlText)
    expect(errors).toEqual([])
    expect(schema.fields).toEqual([{ key: 'tag', label: 'Tag', type: 'multi', options: undefined }])
  })

  it('Roundtrip: user-Feld MIT fillOnRelease: actor', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'approved_by', label: 'Approved by', type: 'user', fillOnRelease: 'actor' }],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: user-Feld OHNE fillOnRelease (Schlüssel fehlt in der YAML)', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'reviewer', label: 'Reviewer', type: 'user' }],
      versioning: false,
    }
    const yamlText = stringifyMetadataSchema(original)
    expect(yamlText).not.toContain('fillOnRelease')
    const { schema, errors } = parseMetadataSchema(yamlText)
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: date-Feld MIT fillOnRelease: date', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'approval_date', label: 'Approval date', type: 'date', fillOnRelease: 'date' }],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: auto-Feld (source: last_author / last_updated)', () => {
    const original: MetadataSchema = {
      fields: [
        { key: 'last_author', label: 'Last author', type: 'auto', source: 'last_author' },
        { key: 'last_updated', label: 'Last updated', type: 'auto', source: 'last_updated' },
      ],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('Roundtrip: required: false bleibt erhalten (volle Treue, kein Umdeuten zu "fehlt")', () => {
    const original: MetadataSchema = {
      fields: [{ key: 'a', label: 'A', type: 'text', required: false }],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })

  it('required fehlt komplett, wenn im Original nicht gesetzt (kein "required: null" in der YAML)', () => {
    const original: MetadataSchema = { fields: [{ key: 'a', label: 'A', type: 'text' }], versioning: false }
    const yamlText = stringifyMetadataSchema(original)
    expect(yamlText).not.toContain('required')
  })

  it('order wird erhalten, wenn im Schema gesetzt', () => {
    const original: MetadataSchema = {
      fields: [
        { key: 'b', label: 'B', type: 'text', order: 2 },
        { key: 'a', label: 'A', type: 'text', order: 1 },
      ],
      versioning: false,
    }
    const yamlText = stringifyMetadataSchema(original)
    // Reparsen sortiert nach `order` — Ergebnis ist "a" vor "b", unabhängig
    // von der (hier bewusst unsortierten) Schreibreihenfolge im Objekt.
    const { schema, errors } = parseMetadataSchema(yamlText)
    expect(errors).toEqual([])
    expect(schema.fields.map((f) => f.key)).toEqual(['a', 'b'])
  })

  it('erzeugt gültiges, von parseMetadataSchema lesbares YAML für ein Schema ganz ohne "order"', () => {
    const original: MetadataSchema = {
      fields: [
        { key: 'erstes', label: 'Erstes', type: 'text' },
        { key: 'zweites', label: 'Zweites', type: 'text' },
      ],
      versioning: false,
    }
    const { schema, errors } = parseMetadataSchema(stringifyMetadataSchema(original))
    expect(errors).toEqual([])
    expect(schema).toEqual(original)
  })
})
