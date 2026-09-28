import { describe, expect, it } from 'vitest'
import { KONTRASTPAARE, contrastRatio, loeseBezug, type KontrastRolle } from '../src/contrast.js'
import { design, tokens } from '../src/tokens.js'

/**
 * Kontrastprüfung des ausgelieferten Token-Satzes.
 *
 * Die Schwellen sind nicht frei gewählt: Sie stehen in
 * `docs/superpowers/specs/2026-07-26-themefaehigkeit-design.md`, Kapitel
 * „Kontrast" — vier Rollen mit je einer Voreinstellung, die der Auftraggeber am
 * 2026-07-26 entschieden hat, nachdem die Messung am Bausteinsystem gezeigt
 * hatte, dass der freigegebene Entwurf die zunächst harten Werte an vier
 * Stellen selbst verfehlt. Dieselbe Tabelle wird später die Theme-Prüfung beim
 * Speichern tragen; dieser Test ist ihr Vorlauf am mitgelieferten Satz.
 *
 * Zwei Dinge prüft er getrennt:
 *
 * 1. Jedes Paar der Rollentabelle erreicht die Schwelle seiner Rolle — hart.
 * 2. Welche Paare unter dem festen AA-Bezug (4,5:1) liegen, steht als Liste im
 *    Test. Der AA-Bezug ist nicht einstellbar: Eine gesenkte Schwelle
 *    verwandelt einen Fehler in eine Warnung, sie lässt ihn nicht
 *    verschwinden. Die Liste ist damit das, was die Anwendung später im Bericht
 *    „Werte unter AA" zeigen muss — und ändert sich einer der Werte, schlägt
 *    der Test an, statt die Abweichung stillschweigend mitzunehmen.
 *
 * Gerechnet wird mit `src/contrast.ts`: Rechnung, Mischung und Paartabelle
 * stehen dort, weil die Einstellungsseite „Erscheinungsbild" dieselben Zahlen
 * anzeigt, die hier geprüft werden. Zwei Fassungen liefen still auseinander.
 */

/** Auf zwei Stellen gerundet — dieselbe Genauigkeit, in der die Spec messt. */
const gerundet = (x: number) => Math.round(x * 100) / 100

/**
 * Voreinstellungen aus „Vier Rollen, vier Voreinstellungen". Instanzweit
 * einstellbar (`_meta/contrast.yaml`), Untergrenze 1,5:1 — hier stehen die
 * Voreinstellungen, gegen die der mitgelieferte Satz antreten muss.
 */
const SCHWELLE: Record<KontrastRolle, number> = {
  Lesetext: 4.5,
  'kurze Schrift': 3.5,
  'nicht-textliche Zeichen': 3.0,
  'beiläufige Beschriftung': 2.0,
}

/** Der feste AA-Bezug (SC 1.4.3) — nicht einstellbar, nur berichtspflichtig. */
const AA = 4.5

// ---------------------------------------------------------------------------
// Prüfung
// ---------------------------------------------------------------------------

for (const mode of ['light', 'dark'] as const) {
  describe(`Ausgeliefert, Theme ${mode}`, () => {
    it('erreicht in jedem Paar die Schwelle seiner Rolle', () => {
      const durchgefallen = KONTRASTPAARE.filter(
        (p) => contrastRatio(loeseBezug(mode, p.vorn), loeseBezug(mode, p.hinten)) < SCHWELLE[p.rolle],
      ).map(
        (p) =>
          `${p.was}: ${gerundet(contrastRatio(loeseBezug(mode, p.vorn), loeseBezug(mode, p.hinten)))}:1 < ${SCHWELLE[p.rolle]}:1 (${p.rolle})`,
      )
      expect(durchgefallen).toEqual([])
    })

    it('deckt alle vier Rollen ab', () => {
      // Sonst prüfte die Schleife oben unbemerkt nur einen Teil der Tabelle.
      expect(new Set(KONTRASTPAARE.map((p) => p.rolle))).toEqual(new Set(Object.keys(SCHWELLE)))
      // 14 Lesetext, 8 kurze Schrift, 9 Zeichen, 1 beiläufig.
      expect(KONTRASTPAARE).toHaveLength(32)
    })
  })
}

/**
 * Die Werte unter AA — festgeschrieben, nicht stillschweigend mitgenommen.
 *
 * Bis Etappe 3 stand hier „Bekannte Kontrast-Unterschreitungen des Entwurfs":
 * zwei Befunde, gemessen am damals noch nicht ausgelieferten Entwurf, mit dem
 * ausdrücklichen Auftrag, sie dem Auftraggeber vor dem Inkrafttreten
 * vorzulegen. Das ist geschehen; die Entscheidung steht in der
 * Themefähigkeits-Spec („Entscheidung des Auftraggebers: Die Kriterien werden
 * so aufgeweicht, dass diese Werte durchgehen"). Beide bestehen ihre Rolle
 * jetzt — und bleiben unter AA. Genau das hält diese Liste fest.
 */
describe('Werte unter dem festen AA-Bezug', () => {
  it('sind genau die drei erwarteten', () => {
    const unterAA = (['light', 'dark'] as const).flatMap((mode) =>
      KONTRASTPAARE.filter((p) => contrastRatio(loeseBezug(mode, p.vorn), loeseBezug(mode, p.hinten)) < AA)
        // Die Rolle „nicht-textliche Zeichen" hat mit SC 1.4.11 einen eigenen,
        // tieferen Normanker; sie ist keine Schrift und fällt nicht unter 1.4.3.
        .filter((p) => p.rolle !== 'nicht-textliche Zeichen')
        .map((p) => `${mode} ${p.was}: ${gerundet(contrastRatio(loeseBezug(mode, p.vorn), loeseBezug(mode, p.hinten)))}`),
    )
    expect(unterAA).toEqual([
      'light Kommentar im Codeblock: 3.63',
      'light Zeilennummern im Codeblock: 2.08',
      'dark Zeilennummern im Codeblock: 2.29',
    ])
  })

  it('hält den Abstand der Rollen zu ihrem kleinsten Messwert', () => {
    // Regel 1 der Herleitung: Jede Voreinstellung liegt rund unter dem
    // kleinsten gemessenen Wert ihrer Rolle, mit mindestens drei Prozent Luft —
    // knapp bemessen, damit eine zweite Absenkung nicht unbemerkt hineinpasst.
    for (const rolle of ['kurze Schrift', 'beiläufige Beschriftung'] as const) {
      const kleinster = Math.min(
        ...(['light', 'dark'] as const).flatMap((mode) =>
          KONTRASTPAARE.filter((p) => p.rolle === rolle).map((p) =>
            contrastRatio(loeseBezug(mode, p.vorn), loeseBezug(mode, p.hinten)),
          ),
        ),
      )
      expect(kleinster / SCHWELLE[rolle], rolle).toBeGreaterThanOrEqual(1.03)
    }
  })
})

/**
 * Der Rand trägt keine harte Schranke — aber die Spec verlangt eine Warnung
 * unter 1,5:1, und der Entwurf liegt darunter. Absicht: Der Rand des Entwurfs
 * ist eine Papierkante, kein Trennstrich; die Rangfolge im Register hängt an
 * `--color-border-strong` und `--color-glyph-state`, und die erreichen ihre
 * Schwellen. Festgeschrieben, damit der Wert nicht unbemerkt noch leiser wird.
 */
describe('Randfarbe gegen Papier', () => {
  it('liegt in beiden Modi unter der Warnschwelle 1,5:1', () => {
    expect(gerundet(contrastRatio(tokens.light['--color-border'], tokens.light['--color-bg']))).toBe(1.33)
    expect(gerundet(contrastRatio(tokens.dark['--color-border'], tokens.dark['--color-bg']))).toBe(1.34)
  })

  it('lässt die kräftigeren Linientöne ihre Aufgabe erfüllen', () => {
    // --color-border-strong ist Linienwerk (keine Schwelle), --color-glyph-state
    // Bedienelement-Grafik (3:1) — der Grund, warum es beide gibt.
    for (const mode of ['light', 'dark'] as const) {
      expect(
        contrastRatio(loeseBezug(mode, '~--color-glyph-state'), tokens[mode]['--color-bg']),
        mode,
      ).toBeGreaterThanOrEqual(3)
      expect(
        contrastRatio(loeseBezug(mode, '~--color-border-strong'), tokens[mode]['--color-bg']),
        mode,
      ).toBeGreaterThan(contrastRatio(tokens[mode]['--color-border'], tokens[mode]['--color-bg']))
    }
  })
})

/**
 * Herkunft und Auslieferung stimmen überein, seit Etappe 4 den Bestand
 * abgeräumt hat. Gemessen wird oben `tokens`; diese Zeile belegt, dass damit
 * auch der Entwurf gemessen ist — sonst prüfte der Test etwas anderes als das,
 * was freigegeben wurde.
 */
describe('Gemessen wird der freigegebene Entwurf', () => {
  it('liefert für jede Farbe den Entwurfswert aus', () => {
    expect(tokens.light).toEqual(design.light)
    expect(tokens.dark).toEqual(design.dark)
    expect(tokens.derived).toEqual(design.derived)
  })
})
