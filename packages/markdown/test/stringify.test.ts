import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMarkdownTree, stringifyMarkdown } from '../src/stringify.js'

const fixturesDir = new URL('./fixtures/canonical/', import.meta.url)
const corpusFiles = readdirSync(fixturesDir).filter((name) => name.endsWith('.md')).sort()

const EXPECTED_GROUPS = [
  'autolink-youtube.md',
  'blockquote-alerts.md',
  'code.md',
  'file-attachments.md',
  'headings.md',
  'images-drawio.md',
  'images-excalidraw.md',
  'inline-marks.md',
  'links-wikilinks.md',
  'lists-tasks.md',
  'mixed-document.md',
  'tables.md',
  'thematic-break.md',
  'youtube-embed.md',
]

describe('Golden-Korpus: Vollständigkeit', () => {
  it('enthält eine Datei pro geplanter Konstrukt-Gruppe', () => {
    expect(corpusFiles).toEqual(EXPECTED_GROUPS)
  })
})

describe('Kanonizitäts-Gesetz: stringifyMarkdown(parseMarkdownTree(md)) === md', () => {
  it.each(corpusFiles)('%s ist byte-identisch', (name) => {
    const md = readFileSync(new URL(name, fixturesDir), 'utf8')
    const tree = parseMarkdownTree(md)
    const out = stringifyMarkdown(tree)
    expect(out).toBe(md)
  })

  it.each(corpusFiles)('%s ist unter einem zweiten Roundtrip stabil', (name) => {
    const md = readFileSync(new URL(name, fixturesDir), 'utf8')
    const firstPass = stringifyMarkdown(parseMarkdownTree(md))
    const secondPass = stringifyMarkdown(parseMarkdownTree(firstPass))
    expect(secondPass).toBe(firstPass)
  })
})

describe('GFM-Autolink-Literale bleiben nackt', () => {
  it('schreibt eine nackte YouTube-URL nicht als <url> oder [url](url)', () => {
    const md = 'Video: https://www.youtube.com/watch?v=dQw4w9WgXcQ\n'
    const out = stringifyMarkdown(parseMarkdownTree(md))
    expect(out).toBe(md)
    expect(out).not.toContain('<https://')
    expect(out).not.toContain('](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
  })

  it('lässt einen echten [Text](url)-Link mit unterschiedlichem Text unangetastet', () => {
    const md = 'Siehe [die Doku](https://example.com/doku) für Details.\n'
    expect(stringifyMarkdown(parseMarkdownTree(md))).toBe(md)
  })
})

describe('GFM-Alerts: Marker bleibt unescaped, andere eckige Klammern bleiben geschützt', () => {
  it.each([
    ['NOTE', 'Ein Hinweis.'],
    ['TIP', 'Ein Tipp.'],
    ['IMPORTANT', 'Wichtig.'],
    ['WARNING', 'Eine Warnung.'],
    ['CAUTION', 'Vorsicht.'],
  ])('[!%s] bleibt in der ersten Blockquote-Zeile unescaped', (marker, text) => {
    const md = `> [!${marker}]\n> ${text}\n`
    expect(stringifyMarkdown(parseMarkdownTree(md))).toBe(md)
  })

  it('escaped eine eckige Klammer am Blockquote-Anfang, die kein bekannter Alert-Typ ist', () => {
    const md = '> [KEIN-ALERT] Text.\n'
    const out = stringifyMarkdown(parseMarkdownTree(md))
    expect(out).toBe('> \\[KEIN-ALERT] Text.\n')
  })
})

describe('Wikilinks respektieren aliasDivider "|"', () => {
  it('serialisiert Ziel ohne Alias als [[ziel]]', () => {
    const md = '[[betrieb/monitoring]]\n'
    expect(stringifyMarkdown(parseMarkdownTree(md))).toBe(md)
  })

  it('serialisiert Ziel mit Alias als [[ziel|alias]]', () => {
    const md = '[[betrieb/monitoring|Monitoring]]\n'
    expect(stringifyMarkdown(parseMarkdownTree(md))).toBe(md)
  })
})
