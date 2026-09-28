import { describe, expect, it } from 'vitest'
import { archivedFromFrontmatter, titleFromFrontmatter } from './frontmatter-fields.js'

describe('titleFromFrontmatter', () => {
  it('liest den Titel aus einem Frontmatter-Block', () => {
    expect(titleFromFrontmatter('---\ntitle: Deployment\n---\n')).toBe('Deployment')
  })

  it('liefert "" ohne title-Feld', () => {
    expect(titleFromFrontmatter('---\nlang: de\n---\n')).toBe('')
  })

  it('liefert "" ohne jedes Frontmatter (frontmatterRaw === "")', () => {
    expect(titleFromFrontmatter('')).toBe('')
  })

  it('liefert "" bei kaputtem YAML (Fail-Soft, kein Wurf)', () => {
    expect(titleFromFrontmatter('---\ntitle: [unclosed\n---\n')).toBe('')
  })

  it('ignoriert andere bekannte/unbekannte Felder', () => {
    const raw = '---\nid: 8f3ka2\ntitle: Betrieb\ntags: [a, b]\nprocess_id: SAP-1\n---\n'
    expect(titleFromFrontmatter(raw)).toBe('Betrieb')
  })
})

describe('archivedFromFrontmatter', () => {
  it('liest archived: true', () => {
    expect(archivedFromFrontmatter('---\ntitle: Alt\narchived: true\n---\n')).toBe(true)
  })

  it('liest archived: false explizit', () => {
    expect(archivedFromFrontmatter('---\ntitle: Aktuell\narchived: false\n---\n')).toBe(false)
  })

  it('liefert false ohne archived-Feld (Default)', () => {
    expect(archivedFromFrontmatter('---\ntitle: Aktuell\n---\n')).toBe(false)
  })

  it('liefert false ohne jedes Frontmatter', () => {
    expect(archivedFromFrontmatter('')).toBe(false)
  })

  it('liefert false bei kaputtem YAML (Fail-Soft, kein Wurf)', () => {
    expect(archivedFromFrontmatter('---\narchived: [unclosed\n---\n')).toBe(false)
  })
})
