import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalog, namesOfLevel, tokenNames } from '../src/catalog.js'
import { buildCss, formulaToCss } from '../src/css.js'

const css = buildCss()

/** Deklarationen je Regel: [Media, Selektor, Name, Wert]. */
function declarations(source: string): { media: string; selector: string; name: string; value: string }[] {
  const out: { media: string; selector: string; name: string; value: string }[] = []
  const stack: string[] = []
  let buf = ''
  for (const ch of source.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      stack.push(buf.replace(/\s+/g, ' ').trim())
      buf = ''
    } else if (ch === '}') {
      stack.pop()
      buf = ''
    } else if (ch === ';') {
      const m = buf.replace(/\s+/g, ' ').trim().match(/^(--[a-z0-9-]+):\s*(.*)$/)
      buf = ''
      if (!m) continue
      const media = stack.filter((s) => s.startsWith('@')).join(' ')
      const selector = stack.filter((s) => !s.startsWith('@')).pop() ?? ''
      out.push({ media, selector, name: m[1]!, value: m[2]! })
    } else buf += ch
  }
  return out
}

const decls = declarations(css)
const namesIn = (pred: (d: (typeof decls)[number]) => boolean) => new Set(decls.filter(pred).map((d) => d.name))

/**
 * Die Tokens einer Ebene, die tatsächlich ins Stylesheet gehen.
 *
 * Nicht jedes Token einer Ebene tut das: `--layout-note-x` wird im Baustein
 * gesetzt, und die 26 Diagramm-Tokens speisen den Generator (`emit:
 * 'generator'`) — ein SVG in einem Bild-Element ist ein abgeschottetes
 * Dokument, die CSS-Variablen der Anwendung existieren dort nicht. Die
 * Ebenen-Zusagen unten gelten deshalb für die erzeugten Tokens, nicht für alle.
 */
const emittiert = (ebene: Parameters<typeof namesOfLevel>[0]) =>
  (namesOfLevel(ebene) as string[]).filter((n) => catalog[n as keyof typeof catalog].emit === 'css')

describe('Erzeugtes CSS', () => {
  it('ist syntaktisch geschlossen und deklariert nur Custom Properties', () => {
    const open = (css.match(/\{/g) ?? []).length
    const close = (css.match(/\}/g) ?? []).length
    expect(open).toBe(close)
    // Jede Nicht-Regel-Zeile ist eine Deklaration `--name: wert;`
    for (const line of css.split('\n').map((l) => l.trim())) {
      if (!line || line.startsWith('/*') || line.endsWith('{') || line === '}') continue
      expect(line).toMatch(/^--[a-z0-9-]+: .+;$/)
    }
  })

  it('erzeugt jedes Token mit Wurzelwert genau einmal je Kontext', () => {
    const erwartet = tokenNames.filter((n) => catalog[n].emit === 'css')
    expect(namesIn(() => true)).toEqual(new Set(erwartet))
  })

  it('lässt die drei kontextgebundenen Tokens aus', () => {
    // Sie werden dort gesetzt, wo sie gelten (Lesetext, Kolumnentitel) — ein
    // Wurzelwert wäre für sie nicht nur überflüssig, sondern falsch.
    const ohne = tokenNames.filter((n) => catalog[n].emit === 'component')
    expect(ohne).toEqual(['--layout-note-x', '--crumbs-mid', '--crumbs-more'])
    for (const n of ohne) expect(css).not.toContain(`${n}:`)
  })

  it('lässt die Diagramm-Tokens aus — sie speisen den Generator, nicht das Stylesheet', () => {
    // Ein Diagramm wird als Bild eingebunden; ein SVG in einem Bild-Element
    // ist ein abgeschottetes Dokument (`routes/media.ts` setzt dafür eine
    // Sandbox-Richtlinie). Stünden diese Werte im Stylesheet, sähe es aus, als
    // erreichte eine Farbänderung die vorhandenen Diagramme — sie erreicht
    // ausschließlich neu erzeugte. Dazu kommt: Die Maße sind einheitenlos
    // (mxGraph-Geometrie), „225" wäre als CSS-Wert schlicht ungültig.
    const generator = tokenNames.filter((n) => catalog[n].emit === 'generator')
    expect(generator).toHaveLength(26)
    expect(generator.every((n) => n.startsWith('--diagram-'))).toBe(true)
    for (const n of generator) expect(css).not.toContain(`${n}:`)
  })
})

describe('Ebenentrennung', () => {
  it('lässt nur Ebene 1 zwischen Hell und Dunkel auseinandergehen', () => {
    // Das ist die eigentliche Zusage der Trennung: Was ein Erscheinungsmodus
    // umschaltet, sind ausschließlich Farben und Schatten. Rutschte ein Maß
    // oder eine Schriftgröße in einen Theme-Block, hinge sie ab da am Modus,
    // ohne dass es jemandem auffiele.
    const dunkel = namesIn(
      (d) => d.selector === '[data-theme="dark"]' || d.selector === ':root:not([data-theme="light"])',
    )
    expect(dunkel).toEqual(new Set(emittiert('theme')))
  })

  it('erzeugt Ebene 1 in allen drei Theme-Blöcken vollständig', () => {
    for (const sel of ['[data-theme="dark"]', ':root:not([data-theme="light"])']) {
      expect(namesIn((d) => d.selector === sel)).toEqual(new Set(emittiert('theme')))
    }
    const hell = decls.filter((d) => d.selector === ':root' && d.media === '')
    for (const n of emittiert('theme')) expect(hell.map((d) => d.name)).toContain(n)
  })

  it('erzeugt Ebene 2 einmal, gültig in jedem Theme-Kontext', () => {
    const abgeleitetNamen: string[] = namesOfLevel('derived')
    const abgeleitet = decls.filter((d) => abgeleitetNamen.includes(d.name))
    expect(new Set(abgeleitet.map((d) => d.selector))).toEqual(
      new Set([':root, [data-theme="light"], [data-theme="dark"]']),
    )
    // Und sie greifen ausschließlich über var() auf Ebene 1 zu — nur so
    // rechnet ein umgeschalteter Teilbaum mit seinen eigenen Grundfarben.
    for (const d of abgeleitet) {
      if (d.name === '--color-scrim') continue
      expect(d.value, d.name).toMatch(/var\(--color-/)
    }
  })

  it('erzeugt Ebene 3 nur an der Wurzel, ohne Theme-Bezug', () => {
    const strukturNamen: string[] = namesOfLevel('structure')
    const struktur = decls.filter((d) => strukturNamen.includes(d.name))
    for (const d of struktur) {
      expect(d.selector, d.name).toBe(':root')
      expect(d.media, d.name).toBe('')
    }
    // Ohne --layout-note-x (im Baustein gesetzt) und ohne die Diagramm-Maße.
    expect(struktur).toHaveLength(emittiert('structure').length)
  })

  it('schreibt Mischvorschriften als color-mix, nicht als fertige Farbe', () => {
    expect(formulaToCss({ kind: 'mix', source: '--color-text', percent: 26, into: '--color-border' })).toBe(
      'color-mix(in srgb, var(--color-text) 26%, var(--color-border))',
    )
    expect(formulaToCss({ kind: 'alias', of: '--color-accent' })).toBe('var(--color-accent)')
    expect(formulaToCss({ kind: 'veil', color: '#0b0a09', percent: 62 })).toBe(
      'color-mix(in srgb, #0b0a09 62%, transparent)',
    )
  })
})

/**
 * Nachweis der Übereinstimmung mit dem Referenzentwurf.
 *
 * Bis Etappe 3 stand hier das Gegenteil: ein Vergleich gegen ein Abbild des
 * Token-Satzes VOR Etappe 1 (`fixtures/tokens-vor-etappe-1.css`). Er war das
 * Sicherungsnetz der sichtgleichen Etappen — solange die Bausteine noch auf
 * die alten Werte gesetzt waren, durfte sich nichts verschieben. Mit Etappe 4
 * tritt der Entwurf in Kraft; ein Test, der Unverändertheit fordert, würde die
 * Absicht der Etappe verbieten.
 *
 * An seiner Stelle prüft dieser Test, was von jetzt an gilt: Was ausgeliefert
 * wird, IST der Entwurf. Verglichen wird gegen `editorial.html` selbst, nicht
 * gegen eine abgeschriebene Werteliste — aus demselben Grund, aus dem
 * `catalog.test.ts` die NAMEN aus dem Entwurf liest: Eine zweite, von Hand
 * gepflegte Kopie wäre genau die Stelle, an der ein Abweichen unbemerkt bliebe.
 *
 * Verglichen wird nicht Zeile für Zeile, sondern der WIRKSAME Wert je
 * Erscheinungsmodus — die Kaskade entscheidet über Spezifität und Reihenfolge,
 * und der Entwurf schreibt seine Blöcke anders als die Erzeugung (er
 * wiederholt den Dunkelsatz im Media-Block, wir tun das auch; er setzt die
 * strukturellen Tokens einmal, wir ebenso).
 */
describe('Übereinstimmung mit dem Referenzentwurf', () => {
  const MOCKUP = fileURLToPath(new URL('../../../docs/design/mockups-2026/editorial.html', import.meta.url))
  const entwurf = (() => {
    const src = readFileSync(MOCKUP, 'utf8')
    return src.slice(src.indexOf('<style>') + 7, src.indexOf('</style>'))
  })()

  /**
   * Nur die Tokens mit Wurzelwert. Die drei kontextgebundenen (`--layout-note-x`
   * und die beiden Brotkrumen-Schalter) setzt der Entwurf dort, wo sie gelten —
   * ein Wurzelwert wäre für sie falsch, und die Erzeugung lässt sie darum aus.
   *
   * Ebenfalls aus dem Vergleich heraus: die nach der Abnahme ergänzten Tokens
   * (`addedAfterMockup`, s. `catalog.ts`). Der Entwurf hat für sie keinen Wert,
   * weil er die Sache fest verdrahtet — ein Sollwert ließe sich hier also nur
   * erfinden. Dass sie überhaupt existieren dürfen und begründet sind, prüft
   * `catalog.test.ts`; dass sie erzeugt werden, der Test „genau einmal je
   * Kontext" weiter oben.
   */
  const gefragt = new Set<string>(
    tokenNames.filter((n) => catalog[n].emit === 'css' && !catalog[n].addedAfterMockup),
  )

  /**
   * Spezifität: `:root:not([data-theme])` bzw. `:root:not([data-theme="light"])`
   * trägt zwei einfache Selektoren und gewinnt damit gegen `:root`.
   */
  function spezifitaet(selector: string): number {
    return selector.startsWith(':root:not(') ? 20 : 10
  }

  type Modus = 'hell' | 'dunkel (Schalter)' | 'dunkel (System)'

  /**
   * Wirksame Werte einer Quelle in einem Modus, auf die gefragten Tokens
   * beschränkt.
   *
   * Bausteinregeln des Entwurfs fallen dabei heraus: Er setzt einzelne Tokens
   * später erneut — im Baustein (`.body` setzt `--layout-note-x`) und am
   * Haltepunkt (`@media (max-width: …)` nimmt `--layout-hang` auf 0 zurück).
   * Beides ist Anwendung, nicht Wertfestlegung. Gezählt werden deshalb nur die
   * Wurzelselektoren des Token-Kapitels, und keine Größen-Media-Query.
   */
  function wirksam(source: string, modus: Modus): Map<string, string> {
    const sieger = new Map<string, { spez: number; rang: number; wert: string }>()
    declarations(source)
      .flatMap((d) => d.selector.split(',').map((s) => ({ ...d, selector: s.trim().replace(/"/g, "'") })))
      .filter((d) => {
        if (!gefragt.has(d.name)) return false
        const dunkelSchalter = d.selector === "[data-theme='dark']"
        const dunkelSystem = d.selector.startsWith(':root:not(')
        const hell = d.selector === ':root' || d.selector === "[data-theme='light']"
        if (!(dunkelSchalter || dunkelSystem || hell)) return false
        const groessenQuery = d.media !== '' && !d.media.includes('prefers-color-scheme')
        if (groessenQuery) return false
        if (modus === 'hell') return hell && d.media === ''
        if (modus === 'dunkel (Schalter)') return (hell || dunkelSchalter) && d.media === ''
        return (hell && d.media === '') || (dunkelSystem && d.media.includes('prefers-color-scheme: dark'))
      })
      .forEach((d, rang) => {
        const spez = spezifitaet(d.selector)
        const bisher = sieger.get(d.name)
        if (!bisher || spez > bisher.spez || (spez === bisher.spez && rang > bisher.rang))
          sieger.set(d.name, { spez, rang, wert: d.value })
      })
    return new Map([...sieger].map(([k, v]) => [k, v.wert]))
  }

  for (const modus of ['hell', 'dunkel (Schalter)', 'dunkel (System)'] as Modus[]) {
    it(`liefert im Modus „${modus}" genau die Werte des Entwurfs`, () => {
      const soll = wirksam(entwurf, modus)
      const ist = wirksam(css, modus)
      // Alle 100 Tokens mit Wurzelwert stehen im Entwurf — sonst prüfte der
      // Vergleich unbemerkt nur eine Teilmenge.
      expect(soll.size).toBe(gefragt.size)
      const abweichungen = [...soll].filter(([n, v]) => ist.get(n) !== v).map(([n, v]) => `${n}: ${v} != ${ist.get(n)}`)
      expect(abweichungen).toEqual([])
    })
  }
})
