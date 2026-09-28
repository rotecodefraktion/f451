import { describe, expect, it } from 'vitest'
import type { MetadataSchema } from '@f451/markdown'
import { applyAutoMetadata } from '../src/spaces/metadata-auto.js'

/**
 * Metadaten-Feature M3b Teil A: reine Ableitungslogik für `type: auto`-Felder,
 * s. `spaces/metadata-auto.ts`-Modulkommentar. Kein DB-/Provider-Zugriff nötig
 * — im Gegensatz zu den meisten `apps/api`-Tests läuft dieser ohne Container.
 */
describe('applyAutoMetadata', () => {
  const schema: MetadataSchema = {
    fields: [
      { key: 'process_id', label: 'Process ID', type: 'text' },
      { key: 'last_author', label: 'Last author', type: 'auto', source: 'last_author' },
      { key: 'last_updated', label: 'Last updated', type: 'auto', source: 'last_updated' },
    ],
  }

  it('setzt last_updated immer aus der Ableitungsquelle', () => {
    const result = applyAutoMetadata(schema, {}, { lastAuthor: null, lastUpdatedIso: '2026-07-16T10:00:00.000Z' })
    expect(result.last_updated).toBe('2026-07-16T10:00:00.000Z')
  })

  it('setzt last_author aus der Ableitungsquelle, wenn bekannt', () => {
    const result = applyAutoMetadata(schema, {}, { lastAuthor: 'bob', lastUpdatedIso: '2026-07-16T10:00:00.000Z' })
    expect(result.last_author).toBe('bob')
  })

  it('last_author unbekannt (null) UND kein Frontmatter-Altwert → Schlüssel fehlt', () => {
    const result = applyAutoMetadata(schema, {}, { lastAuthor: null, lastUpdatedIso: '2026-07-16T10:00:00.000Z' })
    expect('last_author' in result).toBe(false)
  })

  it('last_author unbekannt (null), aber Frontmatter hat einen Altwert → Altwert bleibt erhalten', () => {
    const result = applyAutoMetadata(
      schema,
      { last_author: 'alter-wert-aus-datei' },
      { lastAuthor: null, lastUpdatedIso: '2026-07-16T10:00:00.000Z' },
    )
    expect(result.last_author).toBe('alter-wert-aus-datei')
  })

  it('ein bekannter last_author überschreibt einen evtl. veralteten Frontmatter-Wert', () => {
    const result = applyAutoMetadata(
      schema,
      { last_author: 'alter-wert-aus-datei' },
      { lastAuthor: 'aktueller-autor', lastUpdatedIso: '2026-07-16T10:00:00.000Z' },
    )
    expect(result.last_author).toBe('aktueller-autor')
  })

  it('Nicht-auto-Felder bleiben unverändert', () => {
    const result = applyAutoMetadata(
      schema,
      { process_id: 'SAP-P-0042' },
      { lastAuthor: 'bob', lastUpdatedIso: '2026-07-16T10:00:00.000Z' },
    )
    expect(result.process_id).toBe('SAP-P-0042')
  })

  it('leeres Schema → Metadaten unverändert (Kopie)', () => {
    const metadata = { process_id: 'x' }
    const result = applyAutoMetadata({ fields: [] }, metadata, { lastAuthor: 'bob', lastUpdatedIso: 'x' })
    expect(result).toEqual(metadata)
    expect(result).not.toBe(metadata)
  })

  it('Schema ohne auto-Felder lässt Metadaten unverändert', () => {
    const textOnlySchema: MetadataSchema = { fields: [{ key: 'a', label: 'A', type: 'text' }] }
    const result = applyAutoMetadata(textOnlySchema, { a: 'x' }, { lastAuthor: 'bob', lastUpdatedIso: 'y' })
    expect(result).toEqual({ a: 'x' })
  })
})
