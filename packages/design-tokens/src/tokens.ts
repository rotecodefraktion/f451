import type {
  DerivedTokenName,
  HexColor,
  ShadowTokenName,
  StructureTokenName,
  ThemeColorTokenName,
} from './catalog.js'

/**
 * Werte des Token-Katalogs — in den drei Ebenen des Entwurfs
 * (`docs/superpowers/specs/2026-07-26-erscheinungsbild-2026-design.md`,
 * „Token-Architektur"). Namen, Rollen und Sperren stehen in `catalog.ts`;
 * hier stehen ausschließlich Werte.
 *
 * Ein Satz, seit Etappe 4: `design` — der abgenommene Entwurf „Editorial",
 * vollständig und unverfälscht — IST das, was ausgeliefert wird.
 *
 * Bis Etappe 3 stand daneben ein zweiter Satz. Die Etappen 1 bis 3 überführten
 * den Token-Satz und stellten die Bausteine um, ohne das Aussehen zu ändern;
 * dazu hielt eine Liste `carryOver` 41 Tokens und 7 Mischvorschriften auf den
 * damaligen Produktwerten (Zinc-Grau, reines Weiß, Handoff-Rot #ec3013, feste
 * Schriftgrößen, 8-px-Radien). Etappe 4 räumt sie ab: Die Bausteine stehen, der
 * Entwurf tritt in Kraft. Was die Liste enthielt, steht in der Historie dieser
 * Datei — hier stünde es nur noch als toter Ballast.
 *
 * `tokens` bleibt als Name bestehen, weil `css.ts` und der spätere
 * Theme-Auflöser den ausgelieferten Satz unter diesem Namen lesen: `design`
 * benennt die Herkunft, `tokens` die Rolle. Ein Theme überschreibt später
 * `tokens`, nie `design`.
 */

/** Ebene 1: je ein Wert für Hell und Dunkel. */
export type ThemeValues = Record<ThemeColorTokenName, HexColor> & Record<ShadowTokenName, string>

/**
 * Ebene 2: nicht der fertige Farbwert, sondern die Mischvorschrift.
 *
 * Als Daten statt als CSS-Zeichenkette, weil der spätere Auflöser die
 * Mischung numerisch nachrechnen muss (Kontrastprüfung,
 * `2026-07-26-themefaehigkeit-design.md`, „Ein Auflöser, überall derselbe").
 * Zwei Implementierungen derselben Mischung — eine im Browser, eine im
 * Prüfer — laufen auseinander, und zwar still.
 */
export type DerivedFormula =
  /** `color-mix(in srgb, <source> <percent>%, <into>)` */
  | { readonly kind: 'mix'; readonly source: ThemeColorTokenName; readonly percent: number; readonly into: ThemeColorTokenName }
  /** unveränderte Übernahme einer Theme-Farbe */
  | { readonly kind: 'alias'; readonly of: ThemeColorTokenName }
  /** feste Farbe mit Deckung, unabhängig vom Theme (Schleier hinter dem Dialog) */
  | { readonly kind: 'veil'; readonly color: HexColor; readonly percent: number }

/** Ebene 3: theme-unabhängige Werte. */
export type StructureValues = Record<StructureTokenName, string>

// ---------------------------------------------------------------------------
// Entwurf „Editorial" — Werte 1:1 aus docs/design/mockups-2026/editorial.html
// ---------------------------------------------------------------------------

const designLight: ThemeValues = {
  '--color-bg': '#fffdf8',
  '--color-bg-raised': '#f8f5ec',
  '--color-bg-sunken': '#f0ece1',
  '--color-text': '#1c1a17',
  '--color-text-muted': '#6b655c',
  '--color-accent': '#b3341c',
  '--color-accent-contrast': '#fffdf8',
  '--color-border': '#e3ddd0',
  '--color-danger': '#8e1b1b',
  '--color-status-working': '#4a4fa0',
  '--color-status-review': '#8a5a06',
  '--color-status-released': '#1f6b3a',
  '--color-status-archived': '#6b655c',
  '--color-code-bg': '#f7f3e8',
  '--color-code-text': '#24211d',
  '--color-code-comment': '#857e70',
  '--color-code-gutter': '#b3aa99',
  '--color-mark': '#f6e6a8',
  '--shadow-sm': '0 1px 2px rgba(28, 26, 23, 0.06)',
  '--shadow-md': '0 18px 48px rgba(28, 26, 23, 0.18)',
  '--shadow-accent': '0 1px 2px rgba(179, 52, 28, 0.28)',

  // Diagramm-Hausstil, hell — Werte aus docs/design/diagramm-vorlagen/.
  '--diagram-lane-fill': '#e9e9e9',
  '--diagram-lane-stroke': '#8a94a6',
  '--diagram-lane-label': '#333333',
  '--diagram-terminal-fill': '#8d0981',
  '--diagram-terminal-stroke': '#3b5ba5',
  '--diagram-step-fill': '#e50c2e',
  '--diagram-step-stroke': '#3b5ba5',
  '--diagram-flow-step-stroke': '#5a6b85',
  '--diagram-decision-fill': '#efaa00',
  '--diagram-decision-stroke': '#b7791f',
  '--diagram-label-color': '#ffffff',
  '--diagram-edge-color': '#5a6b85',
}

const designDark: ThemeValues = {
  '--color-bg': '#1a1917',
  '--color-bg-raised': '#232120',
  '--color-bg-sunken': '#121110',
  '--color-text': '#ece7dd',
  '--color-text-muted': '#a09a8e',
  '--color-accent': '#f4795c',
  '--color-accent-contrast': '#16130f',
  '--color-border': '#34302b',
  '--color-danger': '#f08a80',
  '--color-status-working': '#a9aef0',
  '--color-status-review': '#e0b04e',
  '--color-status-released': '#6fcf8f',
  '--color-status-archived': '#a09a8e',
  '--color-code-bg': '#201e1c',
  '--color-code-text': '#ece7dd',
  '--color-code-comment': '#8e877b',
  '--color-code-gutter': '#5c564d',
  '--color-mark': '#5a4a17',
  '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.5)',
  '--shadow-md': '0 18px 48px rgba(0, 0, 0, 0.6)',
  '--shadow-accent': '0 1px 2px rgba(244, 121, 92, 0.3)',

  // Diagramm-Hausstil, dunkel. Nur drei Werte weichen ab, und zwar die drei,
  // bei denen ein fester Wert im Dunkelmodus tatsächlich stört: die Bahnfläche
  // (eine graue Kachel auf dunklem Papier — die Vorlage führt genau hier die
  // Zwei-Modi-Schreibweise), ihre Beschriftung darauf und die Verbindungslinie.
  // Die kräftigen Flächenfarben (Zinnober, Violett, Bernstein) tragen weiße
  // Schrift und stehen in beiden Modi; sie umzufärben hieße, den Hausstil zu
  // verlassen, nicht ihn zu erhalten.
  '--diagram-lane-fill': '#1a1a1a',
  '--diagram-lane-stroke': '#8a94a6',
  '--diagram-lane-label': '#cccccc',
  '--diagram-terminal-fill': '#8d0981',
  '--diagram-terminal-stroke': '#3b5ba5',
  '--diagram-step-fill': '#e50c2e',
  '--diagram-step-stroke': '#3b5ba5',
  '--diagram-flow-step-stroke': '#5a6b85',
  '--diagram-decision-fill': '#efaa00',
  '--diagram-decision-stroke': '#b7791f',
  '--diagram-label-color': '#ffffff',
  '--diagram-edge-color': '#8a94a6',
}

/**
 * Die Mischungen sind theme-unabhängig formuliert und gelten deshalb in beiden
 * Erscheinungsmodi: Wer nur die Grundfarben setzt, bekommt zwölf stimmige
 * Ableitungen geschenkt. Genau das ist der Nutzen der Ebenentrennung.
 */
const derived: Record<DerivedTokenName, DerivedFormula> = {
  '--color-border-hair': { kind: 'mix', source: '--color-border', percent: 55, into: '--color-bg' },
  '--color-border-strong': { kind: 'mix', source: '--color-text', percent: 26, into: '--color-border' },
  // Zustandstragende Zeichen sind Bedienelement-Grafik, nicht Linienwerk: sie
  // brauchen 3:1 gegen ihren Grund (WCAG 1.4.11). --color-border-strong reicht
  // dafür nicht (1,96:1 hell) — daher ein eigener, kräftigerer Ton, der immer
  // noch eine Stufe leiser bleibt als die Beschriftung daneben.
  '--color-glyph-state': { kind: 'mix', source: '--color-text', percent: 50, into: '--color-border' },
  '--color-surface-hover': { kind: 'mix', source: '--color-text', percent: 5, into: '--color-bg' },
  '--color-accent-wash': { kind: 'mix', source: '--color-accent', percent: 8, into: '--color-bg' },
  '--color-accent-line': { kind: 'mix', source: '--color-accent', percent: 42, into: '--color-bg' },
  '--color-danger-wash': { kind: 'mix', source: '--color-danger', percent: 9, into: '--color-bg' },
  '--color-status-working-wash': { kind: 'mix', source: '--color-status-working', percent: 10, into: '--color-bg' },
  '--color-status-review-wash': { kind: 'mix', source: '--color-status-review', percent: 11, into: '--color-bg' },
  '--color-status-released-wash': { kind: 'mix', source: '--color-status-released', percent: 11, into: '--color-bg' },
  '--color-status-archived-wash': { kind: 'mix', source: '--color-status-archived', percent: 10, into: '--color-bg' },
  '--color-focus': { kind: 'alias', of: '--color-accent' },
  // Der Schleier bleibt in beiden Modi derselbe: Er verdeckt den Kontext, den
  // der Dialog kommentiert — das ist keine Frage der Tageszeit.
  '--color-scrim': { kind: 'veil', color: '#0b0a09', percent: 62 },
}

const designStructure: StructureValues = {
  // Serifen im Lesetext ist der Kern der Wirkung des Entwurfs und die
  // deutlichste Abkehr vom heutigen Erscheinungsbild; Grotesk bleibt der
  // Bedienung vorbehalten.
  '--font-text':
    "'Iowan Old Style', 'Charter', 'Palatino Linotype', Palatino, 'Source Serif 4', 'Noto Serif', Georgia, 'Times New Roman', serif",
  '--font-display': "'Iowan Old Style', 'Charter', 'Palatino Linotype', Palatino, 'Source Serif 4', Georgia, serif",
  '--font-sans': "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif",
  '--font-mono':
    "ui-monospace, SFMono-Regular, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",

  '--text-2xs': '0.6875rem',
  '--text-xs': '0.75rem',
  '--text-sm': '0.8125rem',
  '--text-ui': '0.9375rem',
  '--text-md': 'clamp(1.0625rem, 1.02rem + 0.18vw, 1.15rem)',
  '--text-lg': 'clamp(1.1875rem, 1.12rem + 0.3vw, 1.3125rem)',
  '--text-xl': 'clamp(1.4375rem, 1.3rem + 0.6vw, 1.75rem)',
  '--text-2xl': 'clamp(1.75rem, 1.5rem + 1.1vw, 2.25rem)',
  '--text-3xl': 'clamp(2.25rem, 1.85rem + 1.8vw, 3rem)',
  '--text-4xl': 'clamp(2.75rem, 2rem + 3.2vw, 4.25rem)',
  '--cap-ratio': '0.72',
  // Erbt das clamp() der h2 und skaliert damit fluid mit — deshalb eine
  // Rechnung und kein zweiter Größensatz.
  '--text-hang': 'calc(var(--text-xl) * var(--cap-ratio))',

  '--leading-tight': '1.14',
  '--leading-heading': '1.22',
  '--leading-ui': '1.4',
  '--leading-text': '1.68',
  '--leading-code': '1.62',

  '--tracking-tight': '-0.012em',
  '--tracking-normal': '0em',
  '--tracking-caps': '0.1em',

  '--weight-text': '400',
  '--weight-medium': '500',
  '--weight-strong': '650',
  '--weight-display': '600',

  // Building-block switches (group „Bausteine"): the construction the Editorial
  // mockup hard-wires. Attribute tokens — never written to the stylesheet, see
  // catalog.ts TokenEmit. The construction the application had before 1.2.5
  // lives on as the built-in template "rotecodefraktion".
  '--table-style': 'open',
  '--callout-style': 'bar',
  '--card-top-rule': 'on',
  '--button-primary': 'ink',
  '--chip-style': 'outline-caps',
  '--heading-number': 'numeral',
  '--heading-depth': 'top',
  '--toc-style': 'numbered-progress',
  '--tree-guides': 'on',
  '--code-header': 'off',
  '--rail-blocks': 'rules',
  '--list-marker': 'dash',

  // Frame switches (group „Rahmen"): the Editorial frame — no top bar, title
  // row, edge grips, sticky rail, no status bar. The 1.2.5 frame lives on in
  // the templates "rotecodefraktion" and "werkbank".
  '--topbar': 'off',
  '--page-head': 'title',
  '--pane-controls': 'edges',
  '--rail-scroll': 'sticky',
  '--status-bar': 'off',

  '--measure': '68ch',
  '--measure-wide': '96ch',
  '--measure-full': '100%',
  '--density': '1',
  '--rhythm': '1.55rem',
  '--space-0': '0rem',
  '--space-1': '0.25rem',
  '--space-2': '0.5rem',
  '--space-3': '0.75rem',
  '--space-4': '1rem',
  '--space-5': '1.25rem',
  '--space-6': '1.5rem',
  '--space-7': '1.75rem',
  '--space-8': '2rem',
  '--space-9': '3rem',
  '--space-10': '4.5rem',
  '--space-11': '7rem',

  '--layout-nav-w': '17rem',
  '--layout-rail-w': '17rem',
  '--layout-gutter': 'var(--space-9)',
  '--layout-hang': '2.75rem',
  '--layout-note-w': '12.5rem',
  '--layout-note-gap': 'var(--space-6)',
  // Wird im Lesetext gesetzt, nicht an der Wurzel (s. catalog.ts, emit).
  '--layout-note-x': 'calc(var(--measure) + var(--layout-note-gap))',
  '--layout-edge-w': 'var(--control-h)',
  '--layout-app-w':
    'calc(var(--measure-wide) + var(--layout-nav-w) + var(--layout-rail-w) + 2 * var(--layout-gutter) + 2 * var(--layout-edge-w))',
  '--layout-sheet-max': 'calc(var(--layout-app-w) + 2 * var(--space-9))',

  '--rule-hair': '1px',
  '--rule-strong': '2px',
  '--rule-marker': '3px',
  '--diagram-frame-w': 'var(--rule-hair)',

  '--radius-sm': '0.125rem',
  '--radius-md': '0.1875rem',
  '--radius-lg': '0.25rem',
  '--radius-pill': '62.5rem',

  '--control-h': '2.75rem',
  '--control-pad-x': 'calc(var(--space-4) * var(--density))',
  '--control-pad-y': 'calc(var(--space-2) * var(--density))',

  '--focus-w': 'var(--rule-strong)',
  '--focus-offset': 'var(--space-1)',
  '--motion-fast': '120ms',
  '--motion-ease': 'cubic-bezier(0.32, 0.72, 0.3, 1)',

  // Diagramm-Maße aus den Vorlagen. Einheitenlos: mxGraph-Geometrie kennt
  // keine Einheit, und das erzeugte SVG rechnet in denselben Zahlen. Sie
  // gehen deshalb NICHT ins Stylesheet (`emit: 'generator'`) — dort wäre
  // „225" ohne Einheit schlicht ungültig.
  '--diagram-lane-h': '225',
  '--diagram-lane-title-w': '26',
  '--diagram-lane-step-w': '150',
  '--diagram-lane-step-h': '48',
  // 185 = 150 Kastenbreite + 35 Luft. Der Abstand ist der Mitte-zu-Mitte-Wert
  // aus der Vorlage (x = 36, 221, 406, …), nicht der Zwischenraum.
  '--diagram-lane-step-gap': '185',
  '--diagram-flow-node-w': '170',
  '--diagram-flow-node-h': '50',
  '--diagram-flow-terminal-h': '40',
  '--diagram-flow-decision-w': '180',
  '--diagram-flow-decision-h': '80',
  '--diagram-flow-row-gap': '70',
  '--diagram-corner-arc': '40',
  '--diagram-font-family': 'Helvetica',
  '--diagram-font-size': '12',
}

/**
 * Der abgenommene Entwurf, unverfälscht — und seit Etappe 4 zugleich der
 * ausgelieferte Satz.
 */
export const design = {
  light: designLight,
  dark: designDark,
  derived,
  structure: designStructure,
} as const

/**
 * Was ausgeliefert wird. Bis Etappe 3 war das `design`, überschrieben von den
 * Bestandswerten des laufenden Produkts; seit Etappe 4 ist es der Entwurf
 * selbst.
 *
 * Der eigene Name bleibt: `css.ts` und der spätere Theme-Auflöser lesen den
 * ausgelieferten Satz hier, und ein Theme darf ihn verschieben, ohne dass die
 * Herkunftsangabe `design` mitwandert. Die Kontrastprüfung braucht genau diese
 * Trennung — sie misst, was ankommt, nicht, was gemeint war.
 */
export const tokens = design

export default tokens
