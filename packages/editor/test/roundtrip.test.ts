import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { joinFrontmatter, splitFrontmatter } from '@f451/markdown'
import { markdownToDoc } from '../src/from-markdown.js'
import { docToMarkdown } from '../src/to-markdown.js'

// --- Roundtrip-Suite (Task 4, Phase 2b) — das Abnahme-Herzstück der Phase ----------
//
// Beweist für JEDE Datei des Golden-Korpus aus @f451/markdown (Task 1):
//   docToMarkdown(markdownToDoc(md)) === md   (BYTE-IDENTISCH, keine Whitespace-Toleranz)
//
// Die Fixture-Liste wird per Verzeichnis-Listing geladen (nicht hartkodiert) — neue
// Fixtures im Korpus laufen dadurch automatisch mit, analog zum bestehenden
// Smoke-Test in from-markdown.test.ts (dieselbe readdirSync-Konvention).

const CANONICAL_DIR = fileURLToPath(new URL('../../markdown/test/fixtures/canonical/', import.meta.url))
const corpusFiles = readdirSync(CANONICAL_DIR)
  .filter((file) => file.endsWith('.md'))
  .sort()

describe('Roundtrip-Gesetz: docToMarkdown(markdownToDoc(md)) === md (byte-identisch)', () => {
  it('deckt mindestens die bekannten Fixtures ab (Canary gegen leeres Glob)', () => {
    expect(corpusFiles.length).toBeGreaterThan(5)
  })

  // ALLE Fixtures, keine Ausnahmen — auch der Marker-only-Alert mit Leerzeile in
  // blockquote-alerts.md roundtrippt byte-identisch: markdownToDoc konserviert die
  // Quellform als markerOwnParagraph-Attribut am alert-Node (s. nodes/alert.ts),
  // docToMarkdown baut daraus die exakte Ursprungsform zurück.
  it.each(corpusFiles)('gilt byte-identisch für %s', (file) => {
    const markdown = readFileSync(`${CANONICAL_DIR}${file}`, 'utf8')
    const doc = markdownToDoc(markdown)
    expect(docToMarkdown(doc)).toBe(markdown)
  })
})

describe('Roundtrip: Obsidian-Bildbreite `![Alt|400]` byte-identisch', () => {
  it.each([
    '![Programmablauf|400](_media/pa.drawio.svg)\n',
    '![d|400x300](x.png)\n',
    '![|400](x.png)\n',
    // greedy: letztes `|` gewinnt; kein Datenverlust beim Roundtrip
    '![a|b|400](x.png)\n',
    // KEIN Suffix (Ziffernloses `|`) bleibt unangetastet
    '![a|b](x.png)\n',
  ])('gilt byte-identisch für %j', (markdown) => {
    expect(docToMarkdown(markdownToDoc(markdown))).toBe(markdown)
  })
})

describe('Frontmatter-Durchreichung', () => {
  it('Dokument mit Frontmatter: splitFrontmatter -> Body-Roundtrip -> joinFrontmatter, byte-identisch zum Original', () => {
    const body = readFileSync(`${CANONICAL_DIR}mixed-document.md`, 'utf8')
    // Genau EIN Zeilenumbruch zwischen dem schließenden '---' und dem Body (keine
    // zusätzliche Leerzeile) — splitFrontmatter zählt nur diesen einen Umbruch zum
    // Frontmatter-Block (s. frontmatter-split.test.ts), sonst würde die Leerzeile
    // selbst Teil von body und die Gleichheit body === splitBody bräche.
    const md = `---\ntitle: Betriebshandbuch Monitoring\ntags: [monitoring, betrieb]\n---\n${body}`

    const { frontmatterRaw, body: splitBody } = splitFrontmatter(md)
    expect(splitBody).toBe(body)

    const roundtrippedBody = docToMarkdown(markdownToDoc(splitBody))
    expect(roundtrippedBody).toBe(splitBody)

    expect(joinFrontmatter(frontmatterRaw, roundtrippedBody)).toBe(md)
  })

  it('gilt auch ohne Frontmatter (frontmatterRaw === "")', () => {
    const md = readFileSync(`${CANONICAL_DIR}headings.md`, 'utf8')
    const { frontmatterRaw, body } = splitFrontmatter(md)
    expect(frontmatterRaw).toBe('')
    const roundtripped = docToMarkdown(markdownToDoc(body))
    expect(joinFrontmatter(frontmatterRaw, roundtripped)).toBe(md)
  })
})
