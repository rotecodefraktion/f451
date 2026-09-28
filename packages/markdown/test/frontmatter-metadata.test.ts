import { describe, expect, it } from 'vitest'
import { joinFrontmatter, splitFrontmatter } from '../src/frontmatter-split.js'
import { parseFrontmatterBlock } from '../src/frontmatter.js'
import { parsePage } from '../src/parse.js'
import { ensureFrontmatterId, setFrontmatterMetadata } from '../src/frontmatter-metadata.js'

describe('setFrontmatterMetadata', () => {
  it('setzt ein neues Metadaten-Feld in bestehendes Frontmatter', () => {
    const raw = '---\ntitle: Deployment\n---\n'
    const result = setFrontmatterMetadata(raw, { process_id: 'SAP-P-1234' })
    expect(result).toBe('---\ntitle: Deployment\nprocess_id: SAP-P-1234\n---\n')
  })

  it('ändert den Wert eines bereits vorhandenen Metadaten-Felds', () => {
    const raw = '---\ntitle: Deployment\nprocess_id: SAP-P-0001\n---\n'
    const result = setFrontmatterMetadata(raw, { process_id: 'SAP-P-9999' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toEqual({ process_id: 'SAP-P-9999' })
  })

  it('entfernt ein Metadaten-Feld bei leerem String', () => {
    const raw = '---\ntitle: Deployment\nprocess_id: SAP-P-0001\n---\n'
    const result = setFrontmatterMetadata(raw, { process_id: '' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toBeUndefined()
    expect(frontmatter.title).toBe('Deployment')
  })

  it('entfernt ein Metadaten-Feld bei undefined', () => {
    const raw = '---\ntitle: Deployment\nprocess_id: SAP-P-0001\n---\n'
    const result = setFrontmatterMetadata(raw, { process_id: undefined })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toBeUndefined()
  })

  it('entfernt ein Metadaten-Feld bei leerem Array (multi)', () => {
    const raw = '---\ntitle: Deployment\nreviewers:\n  - alice\n  - bob\n---\n'
    const result = setFrontmatterMetadata(raw, { reviewers: [] })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toBeUndefined()
  })

  it('setzt ein multi-Feld als YAML-Liste', () => {
    const raw = '---\ntitle: Deployment\n---\n'
    const result = setFrontmatterMetadata(raw, { reviewers: ['alice', 'bob'] })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toEqual({ reviewers: ['alice', 'bob'] })
  })

  it('erhält bekannte Top-Level-Felder (title/tags/lang/id/relations/archived) unverändert', () => {
    const raw = [
      '---',
      'id: 8f3ka2',
      'title: Deployment',
      'tags: [betrieb, kubernetes]',
      'lang: de',
      'relations:',
      '  depends_on: [betrieb/monitoring]',
      'archived: false',
      '---',
      '',
    ].join('\n')
    const result = setFrontmatterMetadata(raw, { process_id: 'SAP-P-1234' })
    const { frontmatter, errors } = parseFrontmatterBlock(extractInner(result))
    expect(errors).toEqual([])
    expect(frontmatter.id).toBe('8f3ka2')
    expect(frontmatter.title).toBe('Deployment')
    expect(frontmatter.tags).toEqual(['betrieb', 'kubernetes'])
    expect(frontmatter.lang).toBe('de')
    expect(frontmatter.relations).toEqual({ depends_on: ['betrieb/monitoring'] })
    expect(frontmatter.archived).toBe(false)
    expect(frontmatter.metadata).toEqual({ process_id: 'SAP-P-1234' })
  })

  it('baut ein neues Frontmatter, wenn vorher keins existierte (frontmatterRaw === "")', () => {
    const result = setFrontmatterMetadata('', { process_id: 'SAP-P-1234' })
    expect(result.startsWith('---\n')).toBe(true)
    expect(result.endsWith('---\n')).toBe(true)
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toEqual({ process_id: 'SAP-P-1234' })
  })

  it('bleibt "" wenn vorher keins existierte und alle Werte leer sind (kein leerer Frontmatter-Block)', () => {
    expect(setFrontmatterMetadata('', { process_id: '', reviewers: [] })).toBe('')
  })

  it('entfernt den kompletten Frontmatter-Block, wenn danach keine Felder mehr übrig sind', () => {
    const raw = '---\nprocess_id: SAP-P-0001\n---\n'
    const result = setFrontmatterMetadata(raw, { process_id: '' })
    expect(result).toBe('')
  })

  it('behandelt YAML-Sonderzeichen (Doppelpunkt, Anführungszeichen) sicher', () => {
    const raw = '---\ntitle: Deployment\n---\n'
    const value = 'SAP: "Prozess" für Team X'
    const result = setFrontmatterMetadata(raw, { owner: value })
    const { frontmatter, errors } = parseFrontmatterBlock(extractInner(result))
    expect(errors).toEqual([])
    expect(frontmatter.metadata).toEqual({ owner: value })
  })

  it('behandelt leeres Frontmatter ("---\\n---\\n") als Startpunkt', () => {
    const raw = '---\n---\n'
    const result = setFrontmatterMetadata(raw, { process_id: 'SAP-P-1234' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.metadata).toEqual({ process_id: 'SAP-P-1234' })
  })

  it('lässt den BODY unberührt — Integration über splitFrontmatter/joinFrontmatter', () => {
    const doc = '---\ntitle: Deployment\n---\n\n# Überschrift\n\nText mit **Bold**.\n'
    const { frontmatterRaw, body } = splitFrontmatter(doc)
    const newFrontmatterRaw = setFrontmatterMetadata(frontmatterRaw, { process_id: 'SAP-P-1234' })
    const newDoc = joinFrontmatter(newFrontmatterRaw, body)
    expect(newDoc).toBe('---\ntitle: Deployment\nprocess_id: SAP-P-1234\n---\n\n# Überschrift\n\nText mit **Bold**.\n')
    // Roundtrip: erneutes Splitten liefert denselben Body zurück.
    const resplit = splitFrontmatter(newDoc)
    expect(resplit.body).toBe(body)
  })

  it('Roundtrip über mehrere Änderungen hinweg (setzen, ändern, entfernen)', () => {
    let raw = '---\ntitle: Deployment\n---\n'
    raw = setFrontmatterMetadata(raw, { process_id: 'SAP-P-0001', status: 'draft' })
    raw = setFrontmatterMetadata(raw, { process_id: 'SAP-P-0002' })
    raw = setFrontmatterMetadata(raw, { status: '' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(raw))
    expect(frontmatter.title).toBe('Deployment')
    expect(frontmatter.metadata).toEqual({ process_id: 'SAP-P-0002' })
  })

  it('ignoriert Metadaten-Keys, die zufällig wie bekannte Felder heißen NICHT speziell — ganz normale Felder', () => {
    // 'description' ist ein bekanntes Feld (Template-Beschreibung) — setFrontmatterMetadata
    // behandelt es wie jedes andere: wird gesetzt/erhalten, landet aber weiterhin unter
    // dem bekannten Feld, weil es bereits vor dem Aufruf dort stand (Frontmatter-Rohdaten
    // unterscheiden nicht zwischen "bekannt" und "Metadaten" — das ist Sache der
    // darüberliegenden Parse-Schicht, s. frontmatter.ts).
    const raw = '---\ntitle: Deployment\ndescription: Alte Beschreibung\n---\n'
    const result = setFrontmatterMetadata(raw, { owner: 'Team X' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.description).toBe('Alte Beschreibung')
    expect(frontmatter.metadata).toEqual({ owner: 'Team X' })
  })
})

// Feature „Sichtbares Titelfeld"/„Archivieren": `setFrontmatterMetadata` ist
// bereits vollständig generisch (setzt/entfernt JEDEN Top-Level-Schlüssel,
// s. Modulkommentar) — der Editor-Schreibpfad (`editor-root.tsx#handleTitleChange`/
// `handleArchivedToggle`) ruft sie DIREKT mit `{title: …}`/`{archived: …}`
// auf, ohne eigenes Analogon. Diese Tests decken genau diesen Aufruf ab.
describe('setFrontmatterMetadata: title-Setter (Feature „Sichtbares Titelfeld")', () => {
  it('setzt title in bestehendem Frontmatter ohne title-Feld', () => {
    const raw = '---\nlang: de\n---\n'
    const result = setFrontmatterMetadata(raw, { title: 'Neuer Titel' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.title).toBe('Neuer Titel')
    expect(frontmatter.lang).toBe('de')
  })

  it('ändert einen bereits vorhandenen title-Wert', () => {
    const raw = '---\ntitle: Alt\nlang: de\n---\n'
    const result = setFrontmatterMetadata(raw, { title: 'Neu' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.title).toBe('Neu')
  })

  it('entfernt title bei leerem String (Titelfeld geleert)', () => {
    const raw = '---\ntitle: Alt\nlang: de\n---\n'
    const result = setFrontmatterMetadata(raw, { title: '' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.title).toBeUndefined()
    expect(frontmatter.lang).toBe('de')
  })

  it('baut ein Frontmatter von Grund auf (Seite hatte bisher keins)', () => {
    const result = setFrontmatterMetadata('', { title: 'Frisch' })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.title).toBe('Frisch')
  })

  it('behandelt YAML-Sonderzeichen im Titel sicher (Doppelpunkt)', () => {
    const result = setFrontmatterMetadata('---\nlang: de\n---\n', { title: 'Kapitel 1: Einführung' })
    const { frontmatter, errors } = parseFrontmatterBlock(extractInner(result))
    expect(errors).toEqual([])
    expect(frontmatter.title).toBe('Kapitel 1: Einführung')
  })

  it('lässt den BODY unberührt — Integration über splitFrontmatter/joinFrontmatter', () => {
    const doc = '---\ntitle: Alt\n---\n\n# Überschrift\n\nText.\n'
    const { frontmatterRaw, body } = splitFrontmatter(doc)
    const newFrontmatterRaw = setFrontmatterMetadata(frontmatterRaw, { title: 'Neu' })
    const newDoc = joinFrontmatter(newFrontmatterRaw, body)
    expect(newDoc).toBe('---\ntitle: Neu\n---\n\n# Überschrift\n\nText.\n')
    expect(splitFrontmatter(newDoc).body).toBe(body)
  })
})

describe('setFrontmatterMetadata: archived-Setter (Feature „Archivieren")', () => {
  it('setzt archived: true auf einer Seite ohne archived-Feld', () => {
    const raw = '---\ntitle: Alt\n---\n'
    const result = setFrontmatterMetadata(raw, { archived: true })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.archived).toBe(true)
    expect(frontmatter.title).toBe('Alt')
  })

  it('entfernt das archived-Feld bei undefined ("Aus Archiv holen", Konvention: nicht gesetzt = nicht archiviert)', () => {
    const raw = '---\ntitle: Alt\narchived: true\n---\n'
    const result = setFrontmatterMetadata(raw, { archived: undefined })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.archived).toBeUndefined()
  })

  it('schreibt archived: false explizit, wenn ausdrücklich als false übergeben (kein "leer"-Wert für Booleans)', () => {
    const raw = '---\ntitle: Alt\n---\n'
    const result = setFrontmatterMetadata(raw, { archived: false })
    const { frontmatter } = parseFrontmatterBlock(extractInner(result))
    expect(frontmatter.archived).toBe(false)
  })

  it('Roundtrip: archivieren, dann wieder aus dem Archiv holen', () => {
    let raw = '---\ntitle: Alt\n---\n'
    raw = setFrontmatterMetadata(raw, { archived: true })
    expect(parseFrontmatterBlock(extractInner(raw)).frontmatter.archived).toBe(true)
    raw = setFrontmatterMetadata(raw, { archived: undefined })
    const { frontmatter } = parseFrontmatterBlock(extractInner(raw))
    expect(frontmatter.archived).toBeUndefined()
    expect(frontmatter.title).toBe('Alt')
  })
})

/** Test-Helfer: `parseFrontmatterBlock` erwartet reinen YAML-Text (ohne `---`-Zäune,
 *  s. dessen eigene Tests) — `setFrontmatterMetadata` liefert aber den vollen
 *  Frontmatter-Block INKLUSIVE Zäune (wie `frontmatterRaw`/`splitFrontmatter`).
 *  Dieser Helfer zieht den YAML-Kern für Assertions über `parseFrontmatterBlock`
 *  wieder heraus, damit die Tests hier dieselbe Validierungslogik nutzen wie die
 *  echte Pipeline, statt sie zu duplizieren. */
function extractInner(frontmatterRaw: string): string {
  if (!frontmatterRaw.trim()) return ''
  return frontmatterRaw.replace(/^---\r?\n/, '').replace(/\r?\n?---\r?\n?$/, '')
}

describe('ensureFrontmatterId', () => {
  it('fügt die id ein, wenn das Frontmatter keine hat', () => {
    const md = '---\ntitle: Repro\n---\n\n# Repro\n\nInhalt.\n'
    const result = ensureFrontmatterId(md, 'p-abc123')
    const { frontmatter } = parsePage(result)
    expect(frontmatter.id).toBe('p-abc123')
    // Body bleibt unangetastet
    expect(result).toContain('# Repro\n\nInhalt.\n')
  })

  it('lässt den Content BYTE-genau unverändert, wenn die id bereits stimmt', () => {
    const md = '---\nid: p-abc123\ntitle: Repro\n---\n\n# Repro\n'
    // Der Normalfall: kein Reserialisieren, keine Formatänderung
    expect(ensureFrontmatterId(md, 'p-abc123')).toBe(md)
  })

  it('korrigiert eine abweichende id auf die stabile pageId', () => {
    const md = '---\nid: p-falsch\ntitle: Repro\n---\n\n# Repro\n'
    const { frontmatter } = parsePage(ensureFrontmatterId(md, 'p-richtig'))
    expect(frontmatter.id).toBe('p-richtig')
  })

  it('legt Frontmatter mit id an, wenn gar keines vorhanden ist', () => {
    const md = '# Nur Body\n\nKein Frontmatter.\n'
    const result = ensureFrontmatterId(md, 'p-neu')
    const { frontmatter } = parsePage(result)
    expect(frontmatter.id).toBe('p-neu')
    expect(result).toContain('# Nur Body')
  })

  it('lässt kaputtes YAML unangetastet, statt das Frontmatter zu verwerfen (kein stiller Datenverlust)', () => {
    const md = '---\ntitle: My Page\ntags: [unclosed\nlang: de\n---\n# Body\n'
    // Vorher ging bei kaputtem YAML der gesamte uebrige Frontmatter verloren.
    expect(ensureFrontmatterId(md, 'p-xyz')).toBe(md)
  })

  it('korrigiert eine Nicht-String-id und bewahrt die uebrigen Felder', () => {
    const md = '---\nid: 123\ntitle: Repro\ntags: [a, b]\n---\n# Repro\n'
    const { frontmatter } = parsePage(ensureFrontmatterId(md, 'p-korrekt'))
    expect(frontmatter.id).toBe('p-korrekt')
    expect(frontmatter.title).toBe('Repro')
    expect(frontmatter.tags).toEqual(['a', 'b'])
  })

  it('laesst CRLF-Content mit korrekter id byte-genau unveraendert', () => {
    const md = '---\r\nid: p-crlf\r\ntitle: Repro\r\n---\r\n# Repro\r\n'
    expect(ensureFrontmatterId(md, 'p-crlf')).toBe(md)
  })
})
