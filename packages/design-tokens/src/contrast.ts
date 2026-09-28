import type { ThemeColorTokenName } from './catalog.js'
import { tokens } from './tokens.js'

/**
 * Kontrastrechnung und die geprüften Farbpaare — EINE Quelle für den Test
 * (`test/contrast.test.ts`) und für die Einstellungsseite „Erscheinungsbild".
 *
 * Bis hierher stand beides im Test. Die Seite nennt bei jeder Farbe ihren
 * Kontrastwert; hätte sie eine eigene Rechnung und eigene Bezüge, zeigte sie
 * einem Anwender andere Zahlen als die, gegen die geprüft wird — und zwar
 * still. Deshalb liegen Rechnung, Mischung und Paartabelle hier, und der Test
 * liest sie von hier.
 *
 * Was NICHT hier steht: die Schwellen je Rolle. Sie sind eine fachliche
 * Festlegung mit Herleitung und stehen weiter im Test.
 */

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
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

/** Die vier Rollen der Kontrasttabelle; die Schwellen dazu stehen im Test. */
export type KontrastRolle = 'Lesetext' | 'kurze Schrift' | 'nicht-textliche Zeichen' | 'beiläufige Beschriftung'

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

/** Löst einen Bezug im gegebenen Erscheinungsmodus zu einem Hex-Wert auf. */
export function loeseBezug(mode: 'light' | 'dark', bezug: Bezug): string {
  const theme = tokens[mode] as Record<string, string>
  if (!bezug.startsWith('~')) return theme[bezug]!
  const formel = tokens.derived[bezug.slice(1) as keyof typeof tokens.derived]
  switch (formel.kind) {
    case 'mix':
      return mix(theme[formel.source as ThemeColorTokenName]!, formel.percent, theme[formel.into as ThemeColorTokenName]!)
    case 'alias':
      return theme[formel.of as ThemeColorTokenName]!
    case 'veil':
      return formel.color
  }
}
