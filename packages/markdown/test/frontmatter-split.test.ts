import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { joinFrontmatter, splitFrontmatter } from '../src/frontmatter-split.js'

const fixturesDir = new URL('./fixtures/canonical/', import.meta.url)
const corpusFiles = readdirSync(fixturesDir).filter((name) => name.endsWith('.md')).sort()

describe('Roundtrip-Gesetz: joinFrontmatter(...Object.values(splitFrontmatter(md))) === md', () => {
  it.each(corpusFiles)('gilt für %s (kein Frontmatter im Korpus)', (name) => {
    const md = readFileSync(new URL(name, fixturesDir), 'utf8')
    const { frontmatterRaw, body } = splitFrontmatter(md)
    expect(frontmatterRaw).toBe('')
    expect(body).toBe(md)
    expect(joinFrontmatter(frontmatterRaw, body)).toBe(md)
  })

  it.each([
    ['mit Frontmatter, Leerzeile und Body', '---\ntitle: Test\ntags: [a, b]\n---\n\n# Hallo\n'],
    ['mit Frontmatter direkt gefolgt von Body (keine Leerzeile)', '---\ntitle: Test\n---\n# Hallo\n'],
    ['leeres Frontmatter', '---\n---\n\nBody-Text\n'],
    ['Frontmatter ohne abschließenden Zeilenumbruch im Dokument', '---\ntitle: Test\n---'],
    ['Frontmatter mit CRLF', '---\r\ntitle: Test\r\n---\r\n\r\n# Hallo\r\n'],
    ['kein Frontmatter', '# Nur ein Dokument ohne Frontmatter\n'],
    ['leeres Dokument', ''],
    ['Frontmatter, danach direkt EOF ohne Body', '---\ntitle: Test\n---\n'],
  ])('gilt für: %s', (_label, md) => {
    const result = splitFrontmatter(md)
    expect(joinFrontmatter(...(Object.values(result) as [string, string]))).toBe(md)
  })
})

describe('splitFrontmatter: Inhalt der Teile', () => {
  it('trennt Frontmatter (inkl. Zäune und abschließendem Zeilenumbruch) byte-identisch vom Body', () => {
    const md = '---\ntitle: Test\ntags: [a, b]\n---\n\n# Hallo\n'
    const { frontmatterRaw, body } = splitFrontmatter(md)
    expect(frontmatterRaw).toBe('---\ntitle: Test\ntags: [a, b]\n---\n')
    expect(body).toBe('\n# Hallo\n')
  })

  it('liefert frontmatterRaw === "" ohne führenden Frontmatter-Block', () => {
    const md = '# Nur ein Dokument ohne Frontmatter\n'
    const { frontmatterRaw, body } = splitFrontmatter(md)
    expect(frontmatterRaw).toBe('')
    expect(body).toBe(md)
  })

  it('erkennt kein Frontmatter, wenn der Block nicht am Dokumentanfang steht', () => {
    const md = '\n---\ntitle: Test\n---\n\nBody\n'
    const { frontmatterRaw, body } = splitFrontmatter(md)
    expect(frontmatterRaw).toBe('')
    expect(body).toBe(md)
  })
})
