import type { MetadataField, MetadataSchema, PatternField } from '@f451/markdown'
import { describe, expect, it } from 'vitest'
import {
  buildInitialFormValues,
  deriveMetadataFormValues,
  isEditableField,
  isFieldMissing,
  isPatternValid,
  rawMetadataFromFrontmatter,
  toMetadataValues,
} from './metadata-form.js'

function field(partial: Partial<MetadataField> & { key: string; type: MetadataField['type'] }): MetadataField {
  return { label: partial.key, ...partial } as MetadataField
}

describe('isEditableField', () => {
  it('"auto" ist nicht editierbar (M3: nur Anzeige, Ableitung ist M3b)', () => {
    expect(isEditableField(field({ key: 'last_author', type: 'auto', source: 'last_author' }))).toBe(false)
  })

  it('alle anderen Typen sind editierbar', () => {
    expect(isEditableField(field({ key: 'owner', type: 'text' }))).toBe(true)
    expect(isEditableField(field({ key: 'process_id', type: 'pattern', pattern: '.*' }))).toBe(true)
    expect(isEditableField(field({ key: 'status', type: 'enum', options: ['a'] }))).toBe(true)
    expect(isEditableField(field({ key: 'approved_at', type: 'date' }))).toBe(true)
    expect(isEditableField(field({ key: 'reviewers', type: 'multi' }))).toBe(true)
    expect(isEditableField(field({ key: 'approved_by', type: 'user' }))).toBe(true)
  })
})

describe('buildInitialFormValues', () => {
  it('liest einen Text-Wert als String', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'owner', type: 'text' })], versioning: false }
    expect(buildInitialFormValues(schema, { owner: 'Team Platform' })).toEqual({ owner: 'Team Platform' })
  })

  it('fehlender/undefined Wert → leerer String', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'owner', type: 'text' })], versioning: false }
    expect(buildInitialFormValues(schema, {})).toEqual({ owner: '' })
    expect(buildInitialFormValues(schema, null)).toEqual({ owner: '' })
    expect(buildInitialFormValues(schema, undefined)).toEqual({ owner: '' })
  })

  it('multi: Array-Wert bleibt Array von Strings', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'reviewers', type: 'multi' })], versioning: false }
    expect(buildInitialFormValues(schema, { reviewers: ['alice', 'bob'] })).toEqual({ reviewers: ['alice', 'bob'] })
  })

  it('multi: fehlender Wert → leeres Array', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'reviewers', type: 'multi' })], versioning: false }
    expect(buildInitialFormValues(schema, {})).toEqual({ reviewers: [] })
  })

  it('multi: einzelner Skalar wird defensiv als Ein-Element-Array behandelt', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'reviewers', type: 'multi' })], versioning: false }
    expect(buildInitialFormValues(schema, { reviewers: 'alice' })).toEqual({ reviewers: ['alice'] })
  })

  it('multi: leere/null-Einträge im Array werden gefiltert', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'reviewers', type: 'multi' })], versioning: false }
    expect(buildInitialFormValues(schema, { reviewers: ['alice', '', null, 'bob'] })).toEqual({
      reviewers: ['alice', 'bob'],
    })
  })

  it('"auto"-Felder werden NICHT ins Formular-Werte-Objekt aufgenommen (nur Anzeige)', () => {
    const schema: MetadataSchema = {
      fields: [
        field({ key: 'owner', type: 'text' }),
        field({ key: 'last_author', type: 'auto', source: 'last_author' }),
      ],
      versioning: false,
    }
    const values = buildInitialFormValues(schema, { owner: 'x', last_author: 'bob' })
    expect(values).toEqual({ owner: 'x' })
    expect(values.last_author).toBeUndefined()
  })

  it('date/enum/user: numerischer oder boolescher Rohwert wird zu String konvertiert', () => {
    const schema: MetadataSchema = {
      fields: [field({ key: 'status', type: 'enum', options: ['1', '2'] })],
      versioning: false,
    }
    expect(buildInitialFormValues(schema, { status: 1 })).toEqual({ status: '1' })
  })
})

describe('toMetadataValues', () => {
  it('trimmt Text-Werte', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'owner', type: 'text' })], versioning: false }
    expect(toMetadataValues(schema, { owner: '  Team Platform  ' })).toEqual({ owner: 'Team Platform' })
  })

  it('multi: trimmt jeden Eintrag und filtert leere heraus', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'reviewers', type: 'multi' })], versioning: false }
    expect(toMetadataValues(schema, { reviewers: [' alice ', '', 'bob'] })).toEqual({ reviewers: ['alice', 'bob'] })
  })

  it('fehlender Formularwert → leerer String/leeres Array (kein Wurf)', () => {
    const schema: MetadataSchema = {
      fields: [field({ key: 'owner', type: 'text' }), field({ key: 'reviewers', type: 'multi' })],
      versioning: false,
    }
    expect(toMetadataValues(schema, {})).toEqual({ owner: '', reviewers: [] })
  })

  it('"auto"-Felder werden nicht in die Ausgabe aufgenommen (read-only, M3 schreibt sie nie)', () => {
    const schema: MetadataSchema = {
      fields: [field({ key: 'owner', type: 'text' }), field({ key: 'last_author', type: 'auto', source: 'last_author' })],
      versioning: false,
    }
    const result = toMetadataValues(schema, { owner: 'x' })
    expect(result).toEqual({ owner: 'x' })
    expect('last_author' in result).toBe(false)
  })
})

describe('isPatternValid', () => {
  const processId = field({ key: 'process_id', type: 'pattern', pattern: '^SAP-P-\\d+$' }) as PatternField

  it('gültiger Wert gegen das Pattern → true', () => {
    expect(isPatternValid(processId, 'SAP-P-1234')).toBe(true)
  })

  it('ungültiger Wert gegen das Pattern → false', () => {
    expect(isPatternValid(processId, 'nicht-passend')).toBe(false)
  })

  it('leerer Wert ist NIE ein Pattern-Verstoß (Required-Check ist getrennt)', () => {
    expect(isPatternValid(processId, '')).toBe(true)
    expect(isPatternValid(processId, '   ')).toBe(true)
  })

  it('kaputtes Pattern im Schema selbst → fail-open (true), kein Absturz', () => {
    const broken = field({ key: 'x', type: 'pattern', pattern: '(' }) as PatternField
    expect(isPatternValid(broken, 'irgendwas')).toBe(true)
  })
})

describe('isFieldMissing', () => {
  it('nicht required → nie missing', () => {
    const f = field({ key: 'owner', type: 'text' })
    expect(isFieldMissing(f, '')).toBe(false)
  })

  it('required + leerer String → missing', () => {
    const f = field({ key: 'owner', type: 'text', required: true })
    expect(isFieldMissing(f, '')).toBe(true)
    expect(isFieldMissing(f, '   ')).toBe(true)
  })

  it('required + gefüllter String → nicht missing', () => {
    const f = field({ key: 'owner', type: 'text', required: true })
    expect(isFieldMissing(f, 'Team Platform')).toBe(false)
  })

  it('required multi + leeres Array → missing', () => {
    const f = field({ key: 'reviewers', type: 'multi', required: true })
    expect(isFieldMissing(f, [])).toBe(true)
  })

  it('required multi + gefülltes Array → nicht missing', () => {
    const f = field({ key: 'reviewers', type: 'multi', required: true })
    expect(isFieldMissing(f, ['alice'])).toBe(false)
  })
})

describe('rawMetadataFromFrontmatter', () => {
  it('liefert die rohen Metadaten-Werte eines frontmatterRaw-Blocks', () => {
    const raw = '---\ntitle: Deployment\nprocess_id: SAP-P-1234\nlast_author: bob\n---\n'
    expect(rawMetadataFromFrontmatter(raw)).toEqual({ process_id: 'SAP-P-1234', last_author: 'bob' })
  })

  it('kein Frontmatter → {}', () => {
    expect(rawMetadataFromFrontmatter('')).toEqual({})
  })

  it('Frontmatter ohne zusätzliche Metadaten-Felder → {}', () => {
    expect(rawMetadataFromFrontmatter('---\ntitle: Deployment\n---\n')).toEqual({})
  })
})

describe('deriveMetadataFormValues (Integration mit @f451/markdown-Parsing)', () => {
  it('parst frontmatterRaw und baut Formular-Werte aus den Metadaten', () => {
    const schema: MetadataSchema = {
      fields: [field({ key: 'process_id', type: 'pattern', pattern: '.*' })],
      versioning: false,
    }
    const raw = '---\ntitle: Deployment\nprocess_id: SAP-P-1234\n---\n'
    expect(deriveMetadataFormValues(schema, raw)).toEqual({ process_id: 'SAP-P-1234' })
  })

  it('kein Frontmatter → alle Felder leer (kein Wurf)', () => {
    const schema: MetadataSchema = {
      fields: [field({ key: 'process_id', type: 'pattern', pattern: '.*' })],
      versioning: false,
    }
    expect(deriveMetadataFormValues(schema, '')).toEqual({ process_id: '' })
  })

  it('leeres Schema → leeres Werte-Objekt', () => {
    expect(deriveMetadataFormValues({ fields: [], versioning: false }, '---\ntitle: X\n---\n')).toEqual({})
  })
})
