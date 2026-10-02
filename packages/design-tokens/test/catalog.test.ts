import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalog, namesOfLevel, tokenNames, type TokenGroup, type TokenMeta } from '../src/catalog.js'
import { design, tokens } from '../src/tokens.js'

const MOCKUP = fileURLToPath(new URL('../../../docs/design/mockups-2026/editorial.html', import.meta.url))

/**
 * Liest die Token-Namen direkt aus dem Referenzentwurf.
 *
 * Warum aus der Datei und nicht aus einer abgeschriebenen Liste: Der Entwurf
 * ist die abgenommene Vorlage. Eine zweite, von Hand gepflegte Liste wäre
 * genau die Stelle, an der eine Vergesslichkeit unbemerkt bliebe — und ein
 * fehlendes Token fällt sonst erst in Etappe 3 auf, wenn ein Baustein es
 * braucht.
 *
 * `var(--x)`-Verweise werden vorher entwertet, damit nur Deklarationen
 * gezählt werden.
 */
function tokenNamesFromMockup(): Set<string> {
  const src = readFileSync(MOCKUP, 'utf8')
  const style = src.slice(src.indexOf('<style>'), src.indexOf('</style>')).replace(/var\(--[a-z0-9-]+/g, 'var(X')
  const names = new Set<string>()
  for (const m of style.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]!)
  return names
}

describe('Katalog gegen den Referenzentwurf', () => {
  const fromMockup = tokenNamesFromMockup()

  it('deckt genau die 103 Tokens des Entwurfs ab, plus die begründeten Nachträge', () => {
    expect(fromMockup.size).toBe(103)
    expect([...fromMockup].filter((n) => !(n in catalog))).toEqual([])
    // Ein Token, das der Entwurf nicht kennt, MUSS seinen Nachtrag begründen
    // (`addedAfterMockup`) — sonst ist es schlicht eines, das jemand ohne
    // Vorlage erfunden hat. Die Ausnahme steht am Token, nicht hier: eine
    // zweite Liste im Test wäre genau die Stelle, an der ein Nachtrag später
    // unbemerkt bliebe.
    expect(tokenNames.filter((n) => !fromMockup.has(n) && !catalog[n].addedAfterMockup)).toEqual([])
    expect(tokenNames.filter((n) => catalog[n].addedAfterMockup)).toEqual([
      // Zwei Schriftstufen, die die Oberfläche als Literal führte (#77).
      '--text-2xs',
      '--text-ui',
      '--heading-number',
      '--heading-number-sub',
      '--diagram-frame-w',
      // Der Hausstil der Diagramme (2026-07-27-mcp-anhaenge-design.md,
      // Paket 1). Alle 26 tragen dieselbe Begründung — der Entwurf zeigt
      // Bilder, keine Diagramme.
      '--diagram-lane-fill',
      '--diagram-lane-stroke',
      '--diagram-lane-label',
      '--diagram-terminal-fill',
      '--diagram-terminal-stroke',
      '--diagram-step-fill',
      '--diagram-step-stroke',
      '--diagram-flow-step-stroke',
      '--diagram-decision-fill',
      '--diagram-decision-stroke',
      '--diagram-label-color',
      '--diagram-edge-color',
      '--diagram-lane-h',
      '--diagram-lane-title-w',
      '--diagram-lane-step-w',
      '--diagram-lane-step-h',
      '--diagram-lane-step-gap',
      '--diagram-flow-node-w',
      '--diagram-flow-node-h',
      '--diagram-flow-terminal-h',
      '--diagram-flow-decision-w',
      '--diagram-flow-decision-h',
      '--diagram-flow-row-gap',
      '--diagram-corner-arc',
      '--diagram-font-family',
      '--diagram-font-size',
    ])
    expect(tokenNames).toHaveLength(134)
  })

  it('teilt sie auf die Ebenen der Token-Architektur auf', () => {
    // Zahlen aus 2026-07-26-themefaehigkeit-design.md, „Bestandsaufnahme" —
    // die Struktur-Ebene trägt die drei Nachträge (67 + 3), dazu je Ebene die
    // Diagramm-Tokens (Theme 21 + 12 Farben, Struktur 70 + 14 Maße).
    expect(namesOfLevel('theme')).toHaveLength(33)
    expect(namesOfLevel('derived')).toHaveLength(13)
    expect(namesOfLevel('structure')).toHaveLength(86)
    expect(namesOfLevel('switch')).toHaveLength(2)
  })

  it('führt die Gruppen der Einstellungsseite in voller Stärke', () => {
    // Aus 2026-07-26-themefaehigkeit-design.md, „Gliederung" — die Seite
    // gliedert sich genau so, und eine falsch einsortierte Zeile fällt dort
    // niemandem auf.
    const erwartet: Record<TokenGroup, number> = {
      Grundfarben: 9,
      'Workflow-Status': 4,
      'Satz von Code und Markierung': 5,
      Abgeleitet: 13,
      Schatten: 3,
      Schriftfamilien: 4,
      Schriftgrößen: 12,
      Satzdetails: 14,
      'Maß, Raster, Dichte': 27,
      'Linien, Radien, Bedienelemente': 11,
      'Fokus und Bewegung': 4,
      Anzeigeschalter: 2,
      Diagramme: 26,
    }
    const gezaehlt = {} as Record<TokenGroup, number>
    for (const n of tokenNames) gezaehlt[catalog[n].group] = (gezaehlt[catalog[n].group] ?? 0) + 1
    expect(gezaehlt).toEqual(erwartet)
  })
})

describe('Positivliste der Themefähigkeit', () => {
  it('hält die Bilanz 124 setzbar / 10 gesperrt', () => {
    // 84 aus dem Entwurf, dazu die beiden Nachträge der
    // Gliederungsnummerierung und der Diagrammrahmen — alle drei setzbar,
    // denn genau das ist ihr Zweck. Ebenso die 26 Diagramm-Tokens: Der Sinn
    // des Hausstils als Token ist, dass ein Betreiber ihn ändern kann, ohne
    // dass jemand Code anfasst (Nutzergeschichte 17). Dazu die neun
    // Korridor-Tokens (Zeilenlänge, Rasterbreiten, Bedienelementhöhe): setzbar
    // nur innerhalb ihrer `range`.
    const setzbar = tokenNames.filter((n) => catalog[n].settable)
    expect(setzbar).toHaveLength(124)
    expect(tokenNames.length - setzbar.length).toBe(10)
  })

  it('every settable token carries a range', () => {
    const without = tokenNames.filter((n) => catalog[n].settable && !(catalog[n] as TokenMeta).range)
    expect(without).toEqual([])
  })

  it('locked tokens carry no range', () => {
    const wrong = tokenNames.filter((n) => !catalog[n].settable && (catalog[n] as TokenMeta).range)
    expect(wrong).toEqual([])
  })

  it('sperrt genau die Tokens, die eine Zusage tragen', () => {
    const gesperrt = tokenNames.filter((n) => !catalog[n].settable)
    expect(gesperrt.sort()).toEqual(
      [
        '--color-scrim',
        '--crumbs-mid',
        '--crumbs-more',
        '--layout-app-w',
        '--layout-edge-w',
        '--layout-hang',
        '--layout-note-x',
        '--measure-full',
        '--space-0',
        '--text-hang',
      ].sort(),
    )
  })

  it('begründet jede Sperre und benennt jede Rolle', () => {
    for (const n of tokenNames) {
      const meta = catalog[n]
      expect(meta.role.length, `Rolle fehlt: ${n}`).toBeGreaterThan(3)
      if (!meta.settable) expect(meta.lockReason.length, `Sperrbegründung fehlt: ${n}`).toBeGreaterThan(10)
    }
  })
})

describe('Werte', () => {
  it('liegen für jedes Token beider Sätze vor', () => {
    for (const n of namesOfLevel('theme')) {
      expect(design.light[n], n).toBeTruthy()
      expect(design.dark[n], n).toBeTruthy()
      expect(tokens.light[n], n).toBeTruthy()
      expect(tokens.dark[n], n).toBeTruthy()
    }
    for (const n of namesOfLevel('derived')) expect(tokens.derived[n], n).toBeTruthy()
    for (const n of namesOfLevel('structure')) {
      expect(design.structure[n], n).toBeTruthy()
      expect(tokens.structure[n], n).toBeTruthy()
    }
  })

  it('nennt Farben in Hex — die einzige Form, die die Themefähigkeit zulässt', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const n of namesOfLevel('theme')) {
        if (catalog[n].group === 'Schatten') continue
        expect(design[mode][n], `${mode} ${n}`).toMatch(/^#[0-9a-f]{6}$/)
        expect(tokens[mode][n], `${mode} ${n}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('liefert für jedes Token den Entwurfswert aus — ohne Bestandsreste', () => {
    // Bis Etappe 3 stand hier das Gegenteil: eine Schranke, die Bestandswerte
    // NUR für Tokens zuließ, die die laufende App schon benutzte (aus
    // `tokens.css` bzw. dem Eigenvokabular in `10-ableitungen.css`). Sie
    // schützte die sichtgleichen Etappen — ein Bestandswert für ein neues
    // Token wäre ein Wert gewesen, den niemand entworfen hat.
    //
    // Mit Etappe 4 ist der Bestand abgeräumt, und die Schranke kehrt sich um:
    // Es darf gar keinen Wert mehr geben, der vom Entwurf abweicht. Der Test
    // ist damit die Zusage der Etappe, in einer Zeile prüfbar — und die Stelle,
    // an der ein künftiger Rückfall auf einen Produktwert auffällt.
    const abweichungen: string[] = []
    for (const mode of ['light', 'dark'] as const)
      for (const n of namesOfLevel('theme'))
        if (tokens[mode][n] !== design[mode][n]) abweichungen.push(`${mode} ${n}: ${tokens[mode][n]}`)
    for (const n of namesOfLevel('structure'))
      if (tokens.structure[n] !== design.structure[n]) abweichungen.push(`structure ${n}: ${tokens.structure[n]}`)
    for (const n of namesOfLevel('derived'))
      if (JSON.stringify(tokens.derived[n]) !== JSON.stringify(design.derived[n]))
        abweichungen.push(`derived ${n}: ${JSON.stringify(tokens.derived[n])}`)
    expect(abweichungen).toEqual([])
  })
})

