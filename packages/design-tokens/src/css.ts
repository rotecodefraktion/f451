import { catalog, namesOfLevel } from './catalog.js'
import { tokens, type DerivedFormula } from './tokens.js'

/**
 * Erzeugung der CSS-Variablen, getrennt nach den drei Ebenen des Entwurfs.
 *
 * Die Trennung ist keine Kosmetik: Sie entscheidet, WO ein Wert steht und wer
 * ihn später überschreiben darf.
 *
 * 1. Theme-Ebene — je Erscheinungsmodus ein eigener Block. Nur diese Werte
 *    unterscheiden sich zwischen Hell und Dunkel.
 * 2. Abgeleitete Ebene — EIN Block, der in jedem Theme-Kontext gilt. Die
 *    Mischungen greifen über `var()` auf die Theme-Ebene zu und rechnen sich
 *    dort neu, wo der Kontext wechselt. Deshalb steht der Block auch auf
 *    `[data-theme=...]` und nicht nur auf `:root`: Ein umgeschalteter Teilbaum
 *    (die Bausteinvorschau der späteren Einstellungsseite) muss dieselben
 *    Ableitungen mit seinen eigenen Grundfarben bekommen.
 * 3. Struktur-Ebene — einmal an der Wurzel, theme-unabhängig.
 *
 * Zur dritten Ebene gehört eine Folge, die benannt sein will: Die frühere
 * Erzeugung schrieb Schriften, Größen, Abstände und Radien in ALLE drei
 * Theme-Blöcke, obwohl sie in Hell und Dunkel denselben Wert trugen. Der
 * Media-Block hat die Spezifität 0-2-0 (`:root:not([data-theme="light"])`) und
 * gewann damit gegen die `next/font`-Verdrahtung in `globals.css` (`:root`,
 * 0-1-0): Wer dunkel las, ohne die Ansicht ausdrücklich umzuschalten, bekam
 * die textuellen Fallback-Stapel statt der selbst gehosteten Familien. Mit der
 * Ebenentrennung entfallen die Duplikate, und die Verdrahtung greift auch
 * dort — dieselbe Schrift wie im Hellmodus und wie beim ausdrücklich
 * gewählten Dunkelmodus.
 */

const HEADER = '/* generiert aus @f451/design-tokens — nicht von Hand ändern */'

/** Nur Tokens mit einem Wurzelwert; `component` wird dort gesetzt, wo es gilt. */
function emitted<T extends keyof typeof catalog>(names: T[]): T[] {
  return names.filter((n) => catalog[n].emit === 'css')
}

function block(selector: string, decls: string[], indent = ''): string {
  const body = decls.map((d) => `${indent}  ${d}`).join('\n')
  return `${indent}${selector} {\n${body}\n${indent}}`
}

/** Ebene 1 */
function themeDecls(mode: 'light' | 'dark'): string[] {
  return emitted(namesOfLevel('theme')).map((n) => `${n}: ${tokens[mode][n]};`)
}

export function formulaToCss(f: DerivedFormula): string {
  switch (f.kind) {
    case 'mix':
      return `color-mix(in srgb, var(${f.source}) ${f.percent}%, var(${f.into}))`
    case 'alias':
      return `var(${f.of})`
    case 'veil':
      return `color-mix(in srgb, ${f.color} ${f.percent}%, transparent)`
  }
}

/** Ebene 2 */
function derivedDecls(): string[] {
  return emitted(namesOfLevel('derived')).map((n) => `${n}: ${formulaToCss(tokens.derived[n])};`)
}

/** Ebene 3 */
function structureDecls(): string[] {
  return emitted(namesOfLevel('structure')).map((n) => `${n}: ${tokens.structure[n]};`)
}

export function buildCss(): string {
  return [
    HEADER,
    '',
    '/* Ebene 1: theme-abhängige Farben und Schatten */',
    block(':root', themeDecls('light')),
    block('[data-theme="dark"]', themeDecls('dark')),
    '@media (prefers-color-scheme: dark) {',
    block(':root:not([data-theme="light"])', themeDecls('dark'), '  '),
    '}',
    '',
    '/* Ebene 2: abgeleitete Farben — gelten in jedem Theme-Kontext */',
    block(':root, [data-theme="light"], [data-theme="dark"]', derivedDecls()),
    '',
    '/* Ebene 3: strukturelle Tokens — theme-unabhängig */',
    block(':root', structureDecls()),
    '',
  ].join('\n')
}
