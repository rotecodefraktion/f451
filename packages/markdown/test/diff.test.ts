import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diffMarkdown } from '../src/diff.js'

/**
 * Diff-Engine (Phase 2d Task 4) — Golden-Fälle laut Brief: Absatz geändert (Wort-Diff),
 * hinzugefügt, entfernt; Tabelle (Zelle geändert + neue Zeile); Codeblock/Alert geändert
 * (removed+added-Paar); identisches Dokument; Frontmatter-Änderung; XSS-Probe. Fixtures
 * unter fixtures/diff/ — bewusst KEIN reines Byte-für-Byte-JSON-Snapshot für jeden Fall
 * (die gerenderten HTML-Fragmente sind dafür zu formulierungsnah/brüchig), sondern
 * gezielte Inhalts-/Struktur-Assertions je Fall + zwei volle JSON-Golden-Fixtures für die
 * stabilsten Fälle (identical, frontmatter-changed) als Regressionsnetz.
 */

const fixturesDir = new URL('./fixtures/diff/', import.meta.url)

function load(name: string): string {
  return readFileSync(new URL(name, fixturesDir), 'utf8')
}

describe('diffMarkdown: Absatz-Fälle', () => {
  it('Absatz geändert: Wort-Diff-Segmente markieren genau das geänderte Wort', () => {
    const diff = diffMarkdown(load('paragraph-changed.old.md'), load('paragraph-changed.new.md'))
    expect(diff.blocks).toHaveLength(1)
    const [block] = diff.blocks
    expect(block.kind).toBe('changed')
    expect(block.anchor).toBe('c1')
    expect(block.html).toContain('<del class="rm" data-diff="rm">Alte</del>')
    expect(block.html).toContain('<ins class="add" data-diff="add">Neue</ins>')
    expect(block.html).toContain('Zeile mit Text.')
    expect(diff.summary).toEqual({ added: 0, changed: 1, removed: 0 })
  })

  it('Absatz hinzugefügt: same-Block gefolgt von einem added-Block', () => {
    const diff = diffMarkdown(load('paragraph-added.old.md'), load('paragraph-added.new.md'))
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'added'])
    expect(diff.blocks.map((b) => b.anchor)).toEqual(['c1', 'c2'])
    expect(diff.blocks[0].html).toContain('Zeile eins.')
    expect(diff.blocks[1].html).toContain('Neuer Absatz.')
    expect(diff.summary).toEqual({ added: 1, changed: 0, removed: 0 })
  })

  it('Absatz entfernt: same-Block gefolgt von einem removed-Block', () => {
    const diff = diffMarkdown(load('paragraph-removed.old.md'), load('paragraph-removed.new.md'))
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'removed'])
    expect(diff.blocks[1].html).toContain('Wird entfernt.')
    expect(diff.summary).toEqual({ added: 0, changed: 0, removed: 1 })
  })
})

describe('diffMarkdown: Tabelle', () => {
  it('geänderte Zelle + neue Zeile: EIN changed-Block mit Zellvergleich-Postprocessing', () => {
    const diff = diffMarkdown(load('table-diff.old.md'), load('table-diff.new.md'))
    expect(diff.blocks).toHaveLength(1)
    const [block] = diff.blocks
    expect(block.kind).toBe('changed')
    expect(block.html).toContain('erledigt')
    // Geänderte Zelle (Alpha/Status: offen -> erledigt).
    expect(block.html).toMatch(/<td class="cell-chg" data-diff="cell-chg">/)
    expect(block.html).toContain('cellflag')
    // Neue Zeile (Beta) komplett als row-add markiert.
    expect(block.html).toMatch(/<tr class="row-add" data-diff="row-add">/)
    expect(block.html).toContain('Beta')
    expect(diff.summary).toEqual({ added: 0, changed: 1, removed: 0 })
  })

  /* Zugesicherte Eigenschaft 3 der Erscheinungsbild-Spec („Statusfarben tragen immer
   * zusätzlich Zeichen und Wort"): Die Zellmarke war bis Teilschritt I ein LEERES, per
   * `aria-hidden` verstecktes `<span>`. „geändert" und „neu" unterschieden sich damit
   * ausschließlich in der Farbe, die das Stylesheet ihnen gab, und Vorlesesoftware
   * bekam gar nichts. Diese beiden Fälle halten fest, dass jede Art ein EIGENES Zeichen
   * als echten Textinhalt trägt und dass das `aria-hidden` nicht zurückkommt. */
  it('geänderte Zelle: Zellmarke trägt das Zeichen `~` als echten Text, nicht `aria-hidden`', () => {
    const diff = diffMarkdown(load('table-diff.old.md'), load('table-diff.new.md'))
    const [block] = diff.blocks
    expect(block.html).toContain('<span class="cellflag" data-diff="cell-chg">~</span>')
    expect(block.html).not.toContain('aria-hidden')
    // Das Zeichen der ANDEREN Art darf hier nicht auftauchen — sonst wäre es kein
    // Unterscheidungsmerkmal.
    expect(block.html).not.toContain('data-diff="cell-add"')
  })

  it('neue Spalte: Zellmarke trägt das Zeichen `+` in th UND td, nicht `aria-hidden`', () => {
    const diff = diffMarkdown(load('table-cell-add.old.md'), load('table-cell-add.new.md'))
    expect(diff.blocks).toHaveLength(1)
    const [block] = diff.blocks
    expect(block.kind).toBe('changed')
    expect(block.html).toMatch(/<th class="cell-add" data-diff="cell-add">/)
    expect(block.html).toMatch(/<td class="cell-add" data-diff="cell-add">/)
    // Zwei Marken (Kopfzelle „Pruefer" + Datenzelle „Ada"), beide mit dem Pluszeichen.
    expect(block.html.match(/<span class="cellflag" data-diff="cell-add">\+<\/span>/g)).toHaveLength(2)
    expect(block.html).not.toContain('aria-hidden')
    expect(block.html).not.toContain('data-diff="cell-chg"')
  })
})

describe('diffMarkdown: übrige changed-Typen als removed+added-Paar', () => {
  it('Codeblock geändert', () => {
    const diff = diffMarkdown(load('codeblock-changed.old.md'), load('codeblock-changed.new.md'))
    expect(diff.blocks.map((b) => b.kind)).toEqual(['removed', 'added'])
    expect(diff.blocks[0].html).toContain('echo old')
    expect(diff.blocks[1].html).toContain('echo new')
    expect(diff.summary).toEqual({ added: 1, changed: 0, removed: 1 })
  })

  it('Alert geändert', () => {
    const diff = diffMarkdown(load('alert-changed.old.md'), load('alert-changed.new.md'))
    expect(diff.blocks.map((b) => b.kind)).toEqual(['removed', 'added'])
    expect(diff.blocks[0].html).toContain('Alter Hinweistext.')
    expect(diff.blocks[1].html).toContain('Neuer Hinweistext.')
    expect(diff.summary).toEqual({ added: 1, changed: 0, removed: 1 })
  })
})

describe('diffMarkdown: identisches Dokument', () => {
  it('alles same, summary 0/0/0', () => {
    const md = load('identical.md')
    const diff = diffMarkdown(md, md)
    expect(diff.blocks.length).toBeGreaterThan(0)
    expect(diff.blocks.every((b) => b.kind === 'same')).toBe(true)
    expect(diff.summary).toEqual({ added: 0, changed: 0, removed: 0 })
    expect(diff.mdLines.every((l) => l.kind === 'same')).toBe(true)
  })

  it('entspricht dem golden JSON identical.expected.json', () => {
    const md = load('identical.md')
    const diff = diffMarkdown(md, md)
    const expected = JSON.parse(readFileSync(new URL('identical.expected.json', fixturesDir), 'utf8'))
    expect(diff).toEqual(expected)
  })
})

describe('diffMarkdown: Frontmatter-Änderung', () => {
  it('synthetischer changed-Block VOR dem unveränderten Body, Roh-Darstellung beider Stände', () => {
    const diff = diffMarkdown(load('frontmatter-changed.old.md'), load('frontmatter-changed.new.md'))
    const [first, ...rest] = diff.blocks
    expect(first.kind).toBe('changed')
    expect(first.anchor).toBe('c1')
    expect(first.html).toContain('title: Alt')
    expect(first.html).toContain('title: Neu')
    expect(rest.every((b) => b.kind === 'same')).toBe(true)
    expect(diff.summary).toEqual({ added: 0, changed: 1, removed: 0 })
  })

  it('entspricht dem golden JSON frontmatter-changed.expected.json', () => {
    const diff = diffMarkdown(load('frontmatter-changed.old.md'), load('frontmatter-changed.new.md'))
    const expected = JSON.parse(
      readFileSync(new URL('frontmatter-changed.expected.json', fixturesDir), 'utf8'),
    )
    expect(diff).toEqual(expected)
  })
})

describe('diffMarkdown: XSS-Probe (Pflichttest)', () => {
  /**
   * Verschärft laut Review (Finding 1, Fix-Runde 1): die reine Aggregat-Prüfung auf
   * `diff.blocks.map(b => b.html).join('\n')` würde weiter grün bleiben, selbst wenn
   * ein Refactor der Dispatch-Logik (`buildChangedBlocks` in diff.ts) den Absatz still
   * auf das removed+added-Paar zurückfallen ließe (Wort-Diff-Pfad `buildParagraphWordDiffHtml`
   * nicht mehr erreicht) oder die Tabelle nicht mehr über das Zellvergleich-Postprocessing
   * (`buildTableCellDiffHtml`) liefe — beide Fixtures ergäben in dem Fall IMMER NOCH
   * XSS-freies HTML (weil `renderHtml` selbst schon sanitisiert), nur eben ohne die zwei
   * riskanten Hand-HTML-Pfade tatsächlich zu prüfen. Daher zwei Schritte pro Block:
   * (a) exakt der erwartete Pfad wurde genommen (`kind` + Wortdiff-/Zellvergleich-Markup),
   * (b) Injektions-Abwesenheit PRO Block (nicht nur aggregiert).
   */
  it('Absatz-Block: Wort-Diff-Pfad erreicht, script-Tag entkommt nicht', () => {
    const diff = diffMarkdown(load('xss-probe.old.md'), load('xss-probe.new.md'))
    const paragraphBlock = diff.blocks[0]
    // Beweist, dass wirklich der Wort-Diff-Pfad (buildParagraphWordDiffHtml) gelaufen
    // ist und nicht das removed+added-Fallback: EIN changed-Block mit ins/del-Markup.
    expect(paragraphBlock.kind).toBe('changed')
    expect(paragraphBlock.html).toMatch(/<del class="rm" data-diff="rm">/)
    expect(paragraphBlock.html).toMatch(/<ins class="add" data-diff="add">/)
    // Kein echtes <script>-Element (der Wort-Diff zeigt es allenfalls als harmlosen,
    // escapten Text — siehe Kommentar in diff.ts).
    expect(paragraphBlock.html).not.toMatch(/<script[\s>]/i)
    expect(paragraphBlock.html).not.toMatch(/on(?:error|load|click)\s*=/i)
  })

  it('Tabellen-Block: Zellvergleich-Postprocessing erreicht, Event-Handler-Attribut entkommt nicht', () => {
    const diff = diffMarkdown(load('xss-probe.old.md'), load('xss-probe.new.md'))
    const tableBlock = diff.blocks[1]
    // Beweist, dass wirklich das Zellvergleich-Postprocessing (buildTableCellDiffHtml/
    // injectTableDiffAttributes) gelaufen ist und nicht das removed+added-Fallback:
    // EIN changed-Block mit cell-chg-Markup + cellflag-Badge.
    expect(tableBlock.kind).toBe('changed')
    expect(tableBlock.html).toMatch(/<td class="cell-chg" data-diff="cell-chg">/)
    expect(tableBlock.html).toContain('cellflag')
    // Echtes HTML-Element mit Event-Handler-Attribut (Tabellenzelle) wird beim ersten
    // Render bereits vollständig entfernt (wie renderHtml/security.test.ts) und bleibt
    // es auch nach dem Zellvergleich-Postprocessing + Re-Sanitizing.
    expect(tableBlock.html).not.toMatch(/<script[\s>]/i)
    expect(tableBlock.html).not.toMatch(/on(?:error|load|click)\s*=/i)
    expect(tableBlock.html).not.toContain('alert(2)')
    expect(tableBlock.html).not.toContain('alert(4)')
  })

  it('script-Tags und Event-Handler-Attribute überstehen den Diff-Pfad nicht (beide Seiten, Aggregat-Netz)', () => {
    const diff = diffMarkdown(load('xss-probe.old.md'), load('xss-probe.new.md'))
    const html = diff.blocks.map((b) => b.html).join('\n')
    expect(html).not.toMatch(/<script[\s>]/i)
    expect(html).not.toMatch(/on(?:error|load|click)\s*=/i)
    expect(html).not.toContain('alert(2)')
    expect(html).not.toContain('alert(4)')
  })
})

describe('diffMarkdown: mdLines (diffLines über das volle Dokument, inkl. Frontmatter)', () => {
  it('markiert vollständig geänderte Zeilen als rm/add', () => {
    const diff = diffMarkdown(load('paragraph-changed.old.md'), load('paragraph-changed.new.md'))
    expect(diff.mdLines).toEqual([
      { kind: 'rm', text: 'Alte Zeile mit Text.' },
      { kind: 'add', text: 'Neue Zeile mit Text.' },
    ])
  })
})

describe('diffMarkdown: footnotes (blocks are rendered one by one)', () => {
  it('an added block with a reference shows a fn-ref marker instead of literal [^1]', () => {
    const diff = diffMarkdown('Intro.\n', 'Intro.\n\nAdded with a note.[^1]\n\n[^1]: The note text.\n')
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'added', 'added'])
    expect(diff.blocks[1].html).toContain('<sup class="fn-ref">1</sup>')
    expect(diff.blocks[1].html).not.toContain('[^1]')
  })

  it('an added definition block renders .fn-def with its text', () => {
    const diff = diffMarkdown('Intro.\n', 'Intro.\n\nAdded with a note.[^1]\n\n[^1]: The note text.\n')
    const html = diff.blocks[2].html
    expect(html).toContain('<div class="fn-def"><sup>1</sup>')
    expect(html).toContain('The note text.')
  })

  it('a removed definition block renders .fn-def with its text', () => {
    const diff = diffMarkdown('Intro.\n\n[^1]: Gone note.\n', 'Intro.\n')
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'removed'])
    expect(diff.blocks[1].html).toContain('<div class="fn-def"><sup>1</sup>')
    expect(diff.blocks[1].html).toContain('Gone note.')
  })
})

describe('diffMarkdown: opts.resolveLink/resolveImage', () => {
  it('wird für same/added/removed-Blöcke verwendet (nicht für den Wort-Diff, der die Quelle zeigt)', () => {
    const diff = diffMarkdown('Intro.\n', 'Intro.\n\nSiehe [[ziel]].\n', {
      resolveLink: () => ({ href: '/pages/ziel' }),
    })
    expect(diff.blocks[1].kind).toBe('added')
    expect(diff.blocks[1].html).toContain('href="/pages/ziel"')
  })

  it('ohne resolveLink werden Wikilinks in same/added-Blöcken als broken-link markiert (Default)', () => {
    const diff = diffMarkdown('Intro.\n', 'Intro.\n\nSiehe [[ziel]].\n')
    expect(diff.blocks[1].html).toContain('broken-link')
  })
})
