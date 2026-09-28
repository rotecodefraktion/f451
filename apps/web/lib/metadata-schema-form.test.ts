import type { MetadataField, MetadataSchema } from '@f451/markdown'
import { parseMetadataSchemaFromValue } from '@f451/markdown'
import { describe, expect, it } from 'vitest'
import {
  addField,
  changeFieldType,
  createDraftField,
  draftFieldsToPayload,
  moveFieldDown,
  moveFieldUp,
  optionsListToText,
  optionsTextToList,
  removeFieldAt,
  schemaToDraftFields,
  type DraftMetadataField,
} from './metadata-schema-form.js'

describe('createDraftField', () => {
  it('liefert ein leeres text-Feld als Default (ungültig, aber ein sinnvoller Startpunkt)', () => {
    expect(createDraftField()).toEqual({
      key: '',
      label: '',
      type: 'text',
      required: false,
      pattern: '',
      patternHint: '',
      optionsText: '',
      fillOnRelease: '',
      source: '',
    })
  })
})

describe('optionsTextToList / optionsListToText', () => {
  it('optionsTextToList: eine Option pro Zeile, getrimmt, leere Zeilen werden verworfen', () => {
    expect(optionsTextToList('Einkauf\n  Logistik  \n\nFinanzen\n')).toEqual(['Einkauf', 'Logistik', 'Finanzen'])
  })

  it('optionsTextToList: leerer Text → leere Liste', () => {
    expect(optionsTextToList('')).toEqual([])
    expect(optionsTextToList('   \n  \n')).toEqual([])
  })

  it('optionsListToText: Roundtrip mit optionsTextToList', () => {
    const list = ['a', 'b', 'c']
    expect(optionsTextToList(optionsListToText(list))).toEqual(list)
  })

  it('optionsListToText: undefined → leerer String', () => {
    expect(optionsListToText(undefined)).toBe('')
  })
})

describe('addField / removeFieldAt / moveFieldUp / moveFieldDown', () => {
  it('addField hängt ein neues leeres Feld an', () => {
    const fields = addField([])
    expect(fields).toHaveLength(1)
    expect(fields[0]).toEqual(createDraftField())
  })

  it('removeFieldAt entfernt genau den Index, andere bleiben unverändert', () => {
    const fields = [{ ...createDraftField(), key: 'a' }, { ...createDraftField(), key: 'b' }, { ...createDraftField(), key: 'c' }]
    expect(removeFieldAt(fields, 1).map((f) => f.key)).toEqual(['a', 'c'])
  })

  it('moveFieldUp vertauscht mit dem Vorgänger', () => {
    const fields = [{ ...createDraftField(), key: 'a' }, { ...createDraftField(), key: 'b' }]
    expect(moveFieldUp(fields, 1).map((f) => f.key)).toEqual(['b', 'a'])
  })

  it('moveFieldUp am Index 0 ist ein No-Op', () => {
    const fields = [{ ...createDraftField(), key: 'a' }, { ...createDraftField(), key: 'b' }]
    expect(moveFieldUp(fields, 0).map((f) => f.key)).toEqual(['a', 'b'])
  })

  it('moveFieldDown vertauscht mit dem Nachfolger', () => {
    const fields = [{ ...createDraftField(), key: 'a' }, { ...createDraftField(), key: 'b' }]
    expect(moveFieldDown(fields, 0).map((f) => f.key)).toEqual(['b', 'a'])
  })

  it('moveFieldDown am letzten Index ist ein No-Op', () => {
    const fields = [{ ...createDraftField(), key: 'a' }, { ...createDraftField(), key: 'b' }]
    expect(moveFieldDown(fields, 1).map((f) => f.key)).toEqual(['a', 'b'])
  })

  it('Index außerhalb des Bereichs ist für alle vier Helfer ein No-Op', () => {
    const fields = [{ ...createDraftField(), key: 'a' }]
    expect(moveFieldUp(fields, 5)).toEqual(fields)
    expect(moveFieldDown(fields, 5)).toEqual(fields)
    expect(removeFieldAt(fields, 5)).toEqual(fields)
  })
})

describe('changeFieldType', () => {
  it('setzt den neuen Typ, setzt typ-spezifische Felder zurück, behält key/label/required', () => {
    const field: DraftMetadataField = {
      key: 'process_id',
      label: 'Process ID',
      type: 'pattern',
      required: true,
      pattern: '^SAP-P-\\d{4}$',
      patternHint: 'Format: SAP-P-0000',
      optionsText: '',
      fillOnRelease: '',
      source: '',
    }
    expect(changeFieldType(field, 'enum')).toEqual({
      key: 'process_id',
      label: 'Process ID',
      type: 'enum',
      required: true,
      pattern: '',
      patternHint: '',
      optionsText: '',
      fillOnRelease: '',
      source: '',
    })
  })
})

describe('schemaToDraftFields / draftFieldsToPayload — Roundtrip über parseMetadataSchemaFromValue', () => {
  const sapSchema: MetadataSchema = {
    fields: [
      { key: 'process_id', label: 'Process ID', type: 'pattern', pattern: '^SAP-P-\\d{4}$', patternHint: 'Format: SAP-P-0000', required: true },
      { key: 'business_unit', label: 'Business Unit', type: 'enum', options: ['Einkauf', 'Logistik'] },
      { key: 'tag', label: 'Tag', type: 'multi', options: ['a', 'b'] },
      { key: 'notiz', label: 'Notiz', type: 'multi' },
      { key: 'approved_by', label: 'Approved by', type: 'user', fillOnRelease: 'actor' },
      { key: 'reviewer', label: 'Reviewer', type: 'user' },
      { key: 'approval_date', label: 'Approval date', type: 'date', fillOnRelease: 'date' },
      { key: 'owner', label: 'Owner', type: 'text' },
      { key: 'last_author', label: 'Last author', type: 'auto', source: 'last_author' },
    ] as MetadataField[],
    versioning: false,
  }

  it('schemaToDraftFields → draftFieldsToPayload → parseMetadataSchemaFromValue ergibt wieder dasselbe Schema', () => {
    const draftFields = schemaToDraftFields(sapSchema)
    expect(draftFields).toHaveLength(sapSchema.fields.length)

    const payload = draftFieldsToPayload(draftFields, sapSchema.versioning)
    const { schema, errors } = parseMetadataSchemaFromValue(payload)

    expect(errors).toEqual([])
    expect(schema).toEqual(sapSchema)
  })

  it('leeres Schema → leere Draft-Liste → leeres Payload', () => {
    const draftFields = schemaToDraftFields({ fields: [], versioning: false })
    expect(draftFields).toEqual([])
    expect(draftFieldsToPayload(draftFields, false)).toEqual({ fields: [], versioning: false })
  })

  it('draftFieldsToPayload trimmt key/label und lässt required weg, wenn nicht gesetzt', () => {
    const field: DraftMetadataField = {
      key: '  spaced  ',
      label: '  Spaced Label  ',
      type: 'text',
      required: false,
      pattern: '',
      patternHint: '',
      optionsText: '',
      fillOnRelease: '',
      source: '',
    }
    const payload = draftFieldsToPayload([field], false)
    expect(payload).toEqual({ fields: [{ key: 'spaced', label: 'Spaced Label', type: 'text' }], versioning: false })
  })

  it('pattern-Feld ohne patternHint erzeugt kein patternHint-Schlüssel im Payload', () => {
    const field: DraftMetadataField = {
      key: 'p', label: 'P', type: 'pattern', required: false,
      pattern: '^[a-z]+$', patternHint: '', optionsText: '', fillOnRelease: '', source: '',
    }
    const payload = draftFieldsToPayload([field], false)
    expect(payload).toEqual({
      fields: [{ key: 'p', label: 'P', type: 'pattern', pattern: '^[a-z]+$' }],
      versioning: false,
    })
  })

  it('multi-Feld mit leerem optionsText hat KEIN options-Feld im Payload (freie Tag-Eingabe)', () => {
    const field: DraftMetadataField = {
      key: 'tag', label: 'Tag', type: 'multi', required: false,
      pattern: '', patternHint: '', optionsText: '', fillOnRelease: '', source: '',
    }
    const payload = draftFieldsToPayload([field], false) as { fields: Array<Record<string, unknown>> }
    expect('options' in payload.fields[0]!).toBe(false)
  })

  it('auto-Feld ohne gewählte source liefert kein source-Feld — parseMetadataSchemaFromValue verwirft es dann mit Fehler', () => {
    const field: DraftMetadataField = {
      key: 'a', label: 'A', type: 'auto', required: false,
      pattern: '', patternHint: '', optionsText: '', fillOnRelease: '', source: '',
    }
    const payload = draftFieldsToPayload([field], false)
    const { schema, errors } = parseMetadataSchemaFromValue(payload)
    expect(schema.fields).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
  })

  it('draftFieldsToPayload reicht ein geladenes versioning: true unverändert ins Payload durch (Datenverlust-Fix, Etappe 1 Task 2)', () => {
    // Der Schema-Editor hat KEINE Bedienelemente für `versioning` — er darf
    // den Schalter beim Speichern trotzdem nicht stillschweigend auf `false`
    // zurückfallen lassen. Der Aufrufer (`MetadataSchemaEditor`) liest den
    // Ausgangswert aus dem geladenen `MetadataSchema` (`GET .../metadata-schema`)
    // und reicht ihn hier unverändert durch.
    const payload = draftFieldsToPayload([], true)
    expect(payload).toEqual({ fields: [], versioning: true })

    const { schema, errors } = parseMetadataSchemaFromValue(payload)
    expect(errors).toEqual([])
    expect(schema.versioning).toBe(true)
  })

  it('vollständiger Round-Trip: versioning: true geladen → unverändert gespeichert → Schalter bleibt erhalten', () => {
    // Bildet den entscheidenden Fall ohne Browser ab: `schemaToDraftFields`
    // (GET-Antwort → Editor-Zustand) kennt `versioning` bewusst nicht (keine
    // UI dafür) — der Aufrufer muss `schema.versioning` separat halten und ihn
    // beim Bau des PUT-Payloads wieder mitgeben. Dieser Test simuliert genau
    // diesen Aufrufer-Vertrag rein über die Modul-Funktionen.
    const loadedSchema: MetadataSchema = {
      fields: [{ key: 'process_id', label: 'Process ID', type: 'text' }],
      versioning: true,
    }

    const draftFields = schemaToDraftFields(loadedSchema)
    // Unverändert gespeichert — der Nutzer hat keine Felder bearbeitet.
    const payload = draftFieldsToPayload(draftFields, loadedSchema.versioning)
    const { schema, errors } = parseMetadataSchemaFromValue(payload)

    expect(errors).toEqual([])
    expect(schema).toEqual(loadedSchema)
    expect(schema.versioning).toBe(true)
  })
})
