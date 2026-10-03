import type { ThemeColorTokenName } from './catalog.js'
import type { Mode, ModeValues, ResolvedTheme } from './theme.js'
import { tokens } from './tokens.js'

/**
 * Contrast arithmetic, the measured colour pairs and the thresholds per role —
 * ONE source for the test (`test/contrast.test.ts`), for the "Appearance"
 * settings page and for the theme check on save.
 *
 * Both used to live in the test. The page shows a contrast value next to every
 * colour; with its own arithmetic and its own pairs it would show a user
 * different numbers than the ones being checked — silently. So arithmetic,
 * mixing and the pair table live here and the test reads them from here.
 *
 * The thresholds per role are a domain decision with a derivation
 * (`docs/superpowers/specs/2026-07-26-themefaehigkeit-design.md`, "Vier
 * Rollen, vier Voreinstellungen"). They moved here with `checkContrast`: the
 * save check measures the RESOLVED set of a theme (after inheritance, after
 * the derived formulas) against them, and the test pins their values.
 */

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  // The colour grammar admits `#rgb`, `#rgba` and `#rrggbbaa` (grammar.ts).
  // Shorthand is expanded; alpha is dropped — a translucent colour has no
  // contrast of its own without knowing what lies beneath it.
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/**
 * `color-mix(in srgb, a p%, b)` — komponentenweise linear auf den
 * gamma-kodierten Werten, genau wie der Browser es für `in srgb` tut. Beide
 * Farben sind deckend, deshalb entfällt die Gewichtung nach Alpha.
 */
function mix(a: string, percent: number, b: string): string {
  const [ra, rb] = [rgb(a), rgb(b)]
  return `#${ra
    .map((v, i) => Math.round((percent * v + (100 - percent) * rb[i]!) / 100))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** Kontrastverhältnis nach WCAG (SC 1.4.3), ungerundet: 4.2 heißt 4,2:1. */
export function contrastRatio(vordergrund: string, hintergrund: string): number {
  const [l1, l2] = [luminance(vordergrund), luminance(hintergrund)].sort((x, y) => y - x)
  return (l1! + 0.05) / (l2! + 0.05)
}

/** The four roles of the contrast table; their thresholds are `DEFAULT_THRESHOLDS` / `AA_THRESHOLDS`. */
export type KontrastRolle = 'Lesetext' | 'kurze Schrift' | 'nicht-textliche Zeichen' | 'beiläufige Beschriftung'

/** One threshold per role — reading text, short text on a surface, non-text marks, incidental labels. */
export interface ContrastThresholds {
  readingText: number
  shortText: number
  nonText: number
  incidental: number
}

/**
 * The instance-wide defaults the spec decided on. Adjustable later via
 * `_meta/contrast.yaml`; lowering one turns an error into a warning, it never
 * makes the finding disappear — the AA reference below is fixed.
 */
export const DEFAULT_THRESHOLDS: ContrastThresholds = { readingText: 4.5, shortText: 3.5, nonText: 3.0, incidental: 2.0 }

/** The fixed AA reference per role (SC 1.4.3 for text, SC 1.4.11 for non-text). Not adjustable. */
export const AA_THRESHOLDS: ContrastThresholds = { readingText: 4.5, shortText: 4.5, nonText: 3.0, incidental: 4.5 }

const THRESHOLD_FIELD: Record<KontrastRolle, keyof ContrastThresholds> = {
  Lesetext: 'readingText',
  'kurze Schrift': 'shortText',
  'nicht-textliche Zeichen': 'nonText',
  'beiläufige Beschriftung': 'incidental',
}

/**
 * Notation: `--color-x` ist ein Theme-Wert, `~--color-x` ein abgeleiteter, der
 * erst aus seiner Mischvorschrift ausgerechnet wird. Genau darum steht die
 * Formel in `tokens.ts` als Daten und nicht als CSS-Zeichenkette: Der Prüfer
 * muss dieselbe Mischung nachrechnen können wie der Browser.
 */
export type Bezug = `--color-${string}` | `~--color-${string}`

export type Kontrastpaar = { rolle: KontrastRolle; vorn: Bezug; hinten: Bezug; was: string }

/**
 * Welche Vordergrundfarbe gegen welche Fläche gemessen wird.
 *
 * Dieselbe Tabelle trägt die Prüfung im Test und die Kontrastanzeige der
 * Einstellungsseite — die Seite erfindet keine eigenen Bezüge, sonst zeigte
 * sie Werte an, die niemand prüft.
 */
export const KONTRASTPAARE: Kontrastpaar[] = [
  // Lesetext: Text, den man am Stück liest, in Lesegröße.
  { rolle: 'Lesetext', vorn: '--color-text', hinten: '--color-bg', was: 'Fließtext auf Papier' },
  { rolle: 'Lesetext', vorn: '--color-text', hinten: '--color-bg-raised', was: 'Fließtext auf Karte' },
  { rolle: 'Lesetext', vorn: '--color-text', hinten: '--color-bg-sunken', was: 'Fließtext auf Umfeld' },
  { rolle: 'Lesetext', vorn: '--color-text', hinten: '~--color-surface-hover', was: 'Fließtext auf Hover-Fläche' },
  ...(
    [
      '--color-accent-wash',
      '--color-danger-wash',
      '--color-status-working-wash',
      '--color-status-review-wash',
      '--color-status-released-wash',
      '--color-status-archived-wash',
    ] as const
  ).map((w) => ({ rolle: 'Lesetext' as const, vorn: '--color-text' as Bezug, hinten: `~${w}` as Bezug, was: `Fließtext auf ${w}` })),
  { rolle: 'Lesetext', vorn: '--color-text-muted', hinten: '--color-bg', was: 'gedämpfter Text auf Papier' },
  { rolle: 'Lesetext', vorn: '--color-text-muted', hinten: '--color-bg-raised', was: 'gedämpfter Text auf Karte' },
  { rolle: 'Lesetext', vorn: '--color-code-text', hinten: '--color-code-bg', was: 'Code-Tinte auf Codefläche' },
  { rolle: 'Lesetext', vorn: '--color-text', hinten: '--color-mark', was: 'Text auf Textmarker' },

  // Kurze Schrift: Beschriftung, Marke, Anmerkung — erfasst, nicht durchgelesen.
  {
    rolle: 'kurze Schrift',
    vorn: '--color-accent-contrast',
    hinten: '--color-accent',
    was: 'Schaltflächenbeschriftung auf Akzent',
  },
  { rolle: 'kurze Schrift', vorn: '--color-code-comment', hinten: '--color-code-bg', was: 'Kommentar im Codeblock' },
  ...(
    [
      ['--color-accent', '--color-accent-wash'],
      ['--color-danger', '--color-danger-wash'],
      ['--color-status-working', '--color-status-working-wash'],
      ['--color-status-review', '--color-status-review-wash'],
      ['--color-status-released', '--color-status-released-wash'],
      ['--color-status-archived', '--color-status-archived-wash'],
    ] as const
  ).map(([farbe, wash]) => ({
    rolle: 'kurze Schrift' as const,
    vorn: farbe as Bezug,
    hinten: `~${wash}` as Bezug,
    was: `${farbe} als Schrift auf eigener Tönung`,
  })),

  // Nicht-textliche Zeichen: Bedienelement-Grafik, bedeutungstragende Zeichen.
  ...(
    [
      '--color-danger',
      '--color-status-working',
      '--color-status-review',
      '--color-status-released',
      '--color-status-archived',
    ] as const
  ).map((c) => ({
    rolle: 'nicht-textliche Zeichen' as const,
    vorn: c as Bezug,
    hinten: '--color-bg' as Bezug,
    was: `${c} als Zeichen auf Papier`,
  })),
  ...(['--color-bg', '--color-bg-raised'] as const).flatMap((grund) =>
    (['--color-focus', '--color-glyph-state'] as const).map((zeichen) => ({
      rolle: 'nicht-textliche Zeichen' as const,
      vorn: `~${zeichen}` as Bezug,
      hinten: grund as Bezug,
      was: `${zeichen} auf ${grund}`,
    })),
  ),

  // Beiläufige Beschriftung: heute genau ein Paar.
  {
    rolle: 'beiläufige Beschriftung',
    vorn: '--color-code-gutter',
    hinten: '--color-code-bg',
    was: 'Zeilennummern im Codeblock',
  },
]

/**
 * Resolves a reference to a hex value in the given mode.
 *
 * Without `values` it reads the shipped defaults (`tokens`). With a resolved
 * mode map (`ResolvedTheme.light` / `.dark`) it measures that set instead: a
 * plain `--color-x` is read from it, a derived `~--color-x` uses the explicit
 * value if a layer set one and otherwise evaluates the formula with the
 * resolved theme colours as inputs — the same mix the browser performs, since
 * the inline style only overrides the inputs of the formula block.
 */
export function loeseBezug(mode: Mode, bezug: Bezug, values: ModeValues = tokens[mode]): string {
  const theme = values as Record<string, string>
  if (!bezug.startsWith('~')) return theme[bezug]!
  const name = bezug.slice(1)
  const explicit = theme[name]
  if (explicit !== undefined) return explicit
  const formel = tokens.derived[name as keyof typeof tokens.derived]
  switch (formel.kind) {
    case 'mix':
      return mix(theme[formel.source as ThemeColorTokenName]!, formel.percent, theme[formel.into as ThemeColorTokenName]!)
    case 'alias':
      return theme[formel.of as ThemeColorTokenName]!
    case 'veil':
      return formel.color
  }
}

export interface ContrastFinding {
  mode: Mode
  role: KontrastRolle
  pair: Kontrastpaar
  ratio: number
  /** the threshold the finding was measured against (from `thresholds`) */
  threshold: number
  belowThreshold: boolean
  /** below the fixed AA reference of the role — reported even when the threshold passes */
  belowAA: boolean
}

/**
 * Measures every pair of `KONTRASTPAARE` on the resolved set, separately for
 * light and dark (a theme that only sets light values is checked in dark
 * against the inherited dark values — the combination a reader will see).
 * Returns one finding per pair and mode, passing ones included, so a report
 * can show every value; callers filter on `belowThreshold` / `belowAA`.
 */
export function checkContrast(resolved: ResolvedTheme, thresholds: ContrastThresholds = DEFAULT_THRESHOLDS): ContrastFinding[] {
  return (['light', 'dark'] as const).flatMap((mode) =>
    KONTRASTPAARE.map((pair) => {
      const field = THRESHOLD_FIELD[pair.rolle]
      const threshold = thresholds[field]
      const ratio = contrastRatio(loeseBezug(mode, pair.vorn, resolved[mode]), loeseBezug(mode, pair.hinten, resolved[mode]))
      return {
        mode,
        role: pair.rolle,
        pair,
        ratio,
        threshold,
        belowThreshold: ratio < threshold,
        belowAA: ratio < AA_THRESHOLDS[field],
      }
    }),
  )
}
