import type { MetadataField, MetadataSchema } from '@f451/markdown'
import { describe, expect, it } from 'vitest'
import { buildMetadataView, formatMetadataField } from './metadata-view.js'

const DE = 'de' as const

function field(partial: Partial<MetadataField> & { key: string; type: MetadataField['type'] }): MetadataField {
  return { label: partial.key, ...partial } as MetadataField
}

describe('formatMetadataField', () => {
  it('text: gibt den Rohwert als Text zurück', () => {
    const f = field({ key: 'owner', type: 'text', label: 'Owner' })
    expect(formatMetadataField(f, 'Team Platform', DE)).toEqual({
      key: 'owner',
      label: 'Owner',
      kind: 'text',
      value: 'Team Platform',
    })
  })

  it('text: leerer/fehlender Wert → null (Feld wird weggelassen)', () => {
    const f = field({ key: 'owner', type: 'text', label: 'Owner' })
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
    expect(formatMetadataField(f, null, DE)).toBeNull()
    expect(formatMetadataField(f, '', DE)).toBeNull()
    expect(formatMetadataField(f, '   ', DE)).toBeNull()
  })

  it('pattern: wie text formatiert', () => {
    const f = field({ key: 'process_id', type: 'pattern', label: 'Process ID', pattern: 'SAP-P-\\d+' })
    expect(formatMetadataField(f, 'SAP-P-1234', DE)).toEqual({
      key: 'process_id',
      label: 'Process ID',
      kind: 'text',
      value: 'SAP-P-1234',
    })
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
  })

  it('enum: Chip mit dem einzelnen Wert', () => {
    const f = field({ key: 'status', type: 'enum', label: 'Prozessstatus', options: ['draft', 'live'] })
    expect(formatMetadataField(f, 'live', DE)).toEqual({
      key: 'status',
      label: 'Prozessstatus',
      kind: 'chips',
      values: ['live'],
    })
  })

  it('enum: leerer/fehlender Wert → null', () => {
    const f = field({ key: 'status', type: 'enum', label: 'Prozessstatus', options: ['draft', 'live'] })
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
    expect(formatMetadataField(f, '', DE)).toBeNull()
  })

  it('multi: Array von Werten → Chips', () => {
    const f = field({ key: 'reviewers', type: 'multi', label: 'Reviewer' })
    expect(formatMetadataField(f, ['alice', 'bob'], DE)).toEqual({
      key: 'reviewers',
      label: 'Reviewer',
      kind: 'chips',
      values: ['alice', 'bob'],
    })
  })

  it('multi: leeres Array oder fehlender Wert → null', () => {
    const f = field({ key: 'reviewers', type: 'multi', label: 'Reviewer' })
    expect(formatMetadataField(f, [], DE)).toBeNull()
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
  })

  it('multi: Array-Einträge werden gefiltert (leere/null-Werte raus)', () => {
    const f = field({ key: 'reviewers', type: 'multi', label: 'Reviewer' })
    expect(formatMetadataField(f, ['alice', '', null, 'bob'], DE)).toEqual({
      key: 'reviewers',
      label: 'Reviewer',
      kind: 'chips',
      values: ['alice', 'bob'],
    })
  })

  it('multi: einzelner (nicht-leerer) Skalar wird defensiv als Ein-Element-Liste behandelt', () => {
    const f = field({ key: 'reviewers', type: 'multi', label: 'Reviewer' })
    expect(formatMetadataField(f, 'alice', DE)).toEqual({
      key: 'reviewers',
      label: 'Reviewer',
      kind: 'chips',
      values: ['alice'],
    })
  })

  it('date: ISO-Zeitstempel → deutsches Datum (de)', () => {
    const f = field({ key: 'approved_at', type: 'date', label: 'Freigegeben am' })
    expect(formatMetadataField(f, '2026-07-06T09:30:00.000Z', DE)).toEqual({
      key: 'approved_at',
      label: 'Freigegeben am',
      kind: 'text',
      value: '06.07.2026',
    })
  })

  it('date: ISO-Zeitstempel → englisches Datum (en)', () => {
    const f = field({ key: 'approved_at', type: 'date', label: 'Freigegeben am' })
    expect(formatMetadataField(f, '2026-07-06T09:30:00.000Z', 'en')).toEqual({
      key: 'approved_at',
      label: 'Freigegeben am',
      kind: 'text',
      value: '07/06/2026',
    })
  })

  it('date: leerer/fehlender Wert → null', () => {
    const f = field({ key: 'approved_at', type: 'date', label: 'Freigegeben am' })
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
    expect(formatMetadataField(f, '', DE)).toBeNull()
  })

  it('date: ungültiger, nicht-leerer Wert → Rohwert (wie formatUpdatedAt)', () => {
    const f = field({ key: 'approved_at', type: 'date', label: 'Freigegeben am' })
    expect(formatMetadataField(f, 'nicht-ein-datum', DE)).toEqual({
      key: 'approved_at',
      label: 'Freigegeben am',
      kind: 'text',
      value: 'nicht-ein-datum',
    })
  })

  it('user: Name/Handle als Text', () => {
    const f = field({ key: 'approved_by', type: 'user', label: 'Freigegeben von' })
    expect(formatMetadataField(f, '@alice', DE)).toEqual({
      key: 'approved_by',
      label: 'Freigegeben von',
      kind: 'text',
      value: '@alice',
    })
  })

  it('auto (source: last_author): aktueller Wert als Text (Ableitung selbst ist M3b)', () => {
    const f = field({ key: 'last_author', type: 'auto', label: 'Letzter Autor', source: 'last_author' })
    expect(formatMetadataField(f, 'bob', DE)).toEqual({
      key: 'last_author',
      label: 'Letzter Autor',
      kind: 'text',
      value: 'bob',
    })
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
  })

  it('auto (source: last_updated): ISO-Zeitstempel wird wie ein date-Feld formatiert (M3b)', () => {
    const f = field({ key: 'last_updated', type: 'auto', label: 'Zuletzt aktualisiert', source: 'last_updated' })
    expect(formatMetadataField(f, '2026-07-16T09:30:00.000Z', DE)).toEqual({
      key: 'last_updated',
      label: 'Zuletzt aktualisiert',
      kind: 'text',
      value: '16.07.2026',
    })
    expect(formatMetadataField(f, undefined, DE)).toBeNull()
  })
})

describe('buildMetadataView', () => {
  it('kein Schema (null/undefined) → leere Liste', () => {
    expect(buildMetadataView(null, { owner: 'x' }, DE)).toEqual([])
    expect(buildMetadataView(undefined, { owner: 'x' }, DE)).toEqual([])
  })

  it('Schema ohne Felder → leere Liste', () => {
    expect(buildMetadataView({ fields: [], versioning: false }, { owner: 'x' }, DE)).toEqual([])
  })

  it('fehlende/undefined Metadaten → leere Liste (kein Wurf)', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'owner', type: 'text', label: 'Owner' })], versioning: false }
    expect(buildMetadataView(schema, null, DE)).toEqual([])
    expect(buildMetadataView(schema, undefined, DE)).toEqual([])
  })

  it('lässt Schema-Felder ohne Wert weg (keine leeren Zeilen)', () => {
    const schema: MetadataSchema = {
      fields: [
        field({ key: 'owner', type: 'text', label: 'Owner' }),
        field({ key: 'process_id', type: 'pattern', label: 'Process ID', pattern: '.*' }),
      ],
      versioning: false,
    }
    expect(buildMetadataView(schema, { owner: 'Team Platform' }, DE)).toEqual([
      { key: 'owner', label: 'Owner', kind: 'text', value: 'Team Platform' },
    ])
  })

  it('ignoriert Metadaten-Schlüssel, die im Schema nicht vorkommen', () => {
    const schema: MetadataSchema = { fields: [field({ key: 'owner', type: 'text', label: 'Owner' })], versioning: false }
    expect(buildMetadataView(schema, { owner: 'Team Platform', unbekannt: 'x' }, DE)).toEqual([
      { key: 'owner', label: 'Owner', kind: 'text', value: 'Team Platform' },
    ])
  })

  it('sortiert nach "order" (aufsteigend)', () => {
    const schema: MetadataSchema = {
      fields: [
        field({ key: 'b', type: 'text', label: 'B', order: 2 }),
        field({ key: 'a', type: 'text', label: 'A', order: 1 }),
      ],
      versioning: false,
    }
    const view = buildMetadataView(schema, { a: '1', b: '2' }, DE)
    expect(view.map((e) => e.key)).toEqual(['a', 'b'])
  })

  it('Felder ohne "order" behalten ihre relative Position zur ursprünglichen Liste', () => {
    const schema: MetadataSchema = {
      fields: [
        field({ key: 'first', type: 'text', label: 'First' }),
        field({ key: 'withOrder', type: 'text', label: 'WithOrder', order: 0 }),
        field({ key: 'second', type: 'text', label: 'Second' }),
      ],
      versioning: false,
    }
    const view = buildMetadataView(schema, { first: '1', withOrder: '2', second: '3' }, DE)
    // Index 0 (first) hat effektiv order=0, gleich wie withOrder (order:0) →
    // stabil nach ursprünglichem Index: first (Index 0) vor withOrder (Index 1).
    expect(view.map((e) => e.key)).toEqual(['first', 'withOrder', 'second'])
  })

  it('ein Schema-Feld mit key "status" wird als gewöhnlicher Eintrag geliefert (kein Merge mit Workflow-Status)', () => {
    const schema: MetadataSchema = {
      fields: [field({ key: 'status', type: 'enum', label: 'Prozessstatus', options: ['draft', 'live'] })],
      versioning: false,
    }
    expect(buildMetadataView(schema, { status: 'live' }, DE)).toEqual([
      { key: 'status', label: 'Prozessstatus', kind: 'chips', values: ['live'] },
    ])
  })
})
