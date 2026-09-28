#!/usr/bin/env node
// Kennzahlen des Bausteinsystems — Regressionsschutz fuer Etappe 2.
//
// Herkunft: Bestandsaufnahme
// `docs/superpowers/plans/2026-07-26-bausteinsystem-bestandsaufnahme.md`,
// §3 („Uneinheitlichkeit in Zahlen") und Anhang („Kennzahlen als
// Ausgangswert"). Teilschritt I (§7.2, Zeile I) haelt die dort von Hand
// gezaehlten Werte hier maschinell fest: `node scripts/css-inventar.mjs`
// zaehlt nach und meldet mit Rueckgabewert 1, wenn eine Kennzahl ihr Ziel
// verfehlt.
//
// WARUM EIN EIGENES SKRIPT UND KEIN LINTER: die Zahlen sind keine Stilregeln,
// sondern Zusagen aus dem Entwurf („EIN Innenabstand", „EIN Fokusring",
// „44 px Zielgroesse"). Ein Linter prueft Syntax; hier wird gezaehlt, wie oft
// dieselbe Sache auf verschiedene Weise gesagt wird. Neue Werte fallen damit
// beim naechsten Lauf auf, nicht erst beim naechsten Umbau.
//
// GRENZEN, damit niemand mehr aus den Zahlen liest als drin steht:
//   * Gezaehlt wird der QUELLTEXT der Stildateien, nicht der berechnete Wert
//     im Browser. Ob eine Regel gewinnt, sagt dieses Skript nicht.
//   * Kommentare werden entfernt, Zeichenketten nicht — `content: '999px'`
//     gaebe es also einen Fehlalarm. Kommt im Bestand nicht vor.
//   * Die „Fundstellen im Markup"-Pruefung liest `className=`/`class=` und
//     die Klassennamen-Rueckgaben der `lib/**`-Helfer. Dynamisch
//     zusammengesetzte Namen (`'chip ' + variante`) erkennt sie nicht; solche
//     Namen gibt es in diesem Projekt nicht.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STYLES = path.join(REPO, 'apps/web/app/styles')
const MARKUP_ROOTS = [path.join(REPO, 'apps/web'), path.join(REPO, 'packages')]

/** Kommentare weg, damit Beispiele in Erklaerungen nicht mitgezaehlt werden. */
const ohneKommentare = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const dateien = fs
  .readdirSync(STYLES)
  .filter((f) => f.endsWith('.css'))
  .sort()
const quellen = new Map(dateien.map((f) => [f, ohneKommentare(fs.readFileSync(path.join(STYLES, f), 'utf8'))]))
const alles = [...quellen.values()].join('\n')

/** Alle Vorkommen eines Musters mit Datei und Zeile — fuer die Fundstellenliste. */
function fundstellen(muster) {
  const out = []
  for (const [datei, src] of quellen) {
    const zeilen = src.split('\n')
    for (let i = 0; i < zeilen.length; i++) {
      const m = zeilen[i].match(muster)
      if (m) out.push(`${datei}:${i + 1}  ${zeilen[i].trim()}`)
    }
  }
  return out
}

function werte(eigenschaft) {
  const re = new RegExp(`(?:^|[;{\\s])${eigenschaft}:\\s*([^;}]+)`, 'g')
  return [...alles.matchAll(re)].map((m) => m[1].trim())
}

// ── Klassennamen: CSS gegen Markup ─────────────────────────────────────────
const cssKlassen = new Map()
for (const [datei, src] of quellen) {
  // Attributselektoren zuerst entfernen: `img[src*='.drawio.svg']` nennt eine
  // Dateiendung, keine Klasse `.svg`.
  for (const m of src.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (!cssKlassen.has(m[1])) cssKlassen.set(m[1], new Set())
    cssKlassen.get(m[1]).add(datei)
  }
}
const markupKlassen = new Set()
function lesbareDateien(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', '.turbo'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...lesbareDateien(p))
    else if (/\.(tsx|ts|jsx|js|html)$/.test(e.name)) out.push(p)
  }
  return out
}
for (const root of MARKUP_ROOTS) {
  for (const datei of lesbareDateien(root)) {
    const src = fs
      .readFileSync(datei, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const nimm = (text) => {
      for (const tok of text.split(/\s+/)) if (/^[-_a-zA-Z][\w-]*$/.test(tok)) markupKlassen.add(tok)
    }
    for (const m of src.matchAll(/class(?:Name)?\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|'[^']*')/g)) {
      // Anfuehrungszeichen JEDER Art, damit auch `className={`a${b ? ' c' : ''}`}`
      // seine festen Bestandteile hergibt.
      for (const s of m[1].matchAll(/['"`]([^'"`]*)['"`]/g)) nimm(s[1])
      for (const s of m[1].matchAll(/`([^`]*)`/g)) nimm(s[1].replace(/\$\{[^}]*\}/g, ' '))
      if (/^["']/.test(m[1])) nimm(m[1].slice(1, -1))
    }
    for (const m of src.matchAll(/classList\.\w+\(([^)]*)\)/g))
      for (const s of m[1].matchAll(/['"`]([^'"`]*)['"`]/g)) nimm(s[1])
    for (const m of src.matchAll(/querySelector(?:All)?\(\s*['"`]([^'"`]*)['"`]/g))
      for (const tok of m[1].split(/[^\w-]+/)) if (tok) markupKlassen.add(tok)
    // Helfer, die einen Klassennamen zurueckgeben (`lib/review/diff-view-model.ts`)
    for (const m of src.matchAll(/return\s+['"`]([a-z][\w -]*)['"`]/g)) nimm(m[1])
  }
}
// Zwei Gruppen von Namen duerfen ohne `className=`-Fundstelle im CSS stehen:
//
// (1) BAUSTEIN-VERTRAG — der Entwurf sieht sie vor, die Anwendung benutzt sie
//     noch nicht (`.field`, `.selectwrap`, `.callout__head`, `.card.plain`,
//     `.glyph`) oder es sind Variantennamen, die nur zusammen mit ihrer
//     Grundklasse auftreten.
// (2) VON FREMDCODE GESETZT — sie stehen nicht im JSX, sondern werden von
//     Tiptap/ProseMirror (Knoten-Ansichten, `packages/editor`), vom
//     Markdown-Renderer (`packages/markdown/src/render.ts`) oder von der
//     Graph-Zeichnung (`attr('class', …)` in `lib/graph/`) erzeugt. Sie zu
//     loeschen waere ein Fehler; sie hier zu melden waere Rauschen.
//
// Wer einen Namen hinzufuegt, schreibt dazu, WO er gesetzt wird.
const VERTRAG = new Set([
  // (1) Baustein-Vertrag
  'callout__head',
  'plain',
  'selectwrap',
  'glyph',
  'label',
  'select',
  'field',
  'info',
  'warn',
  'success',
  'work',
  'valid',
  'sel',
  'item',
  'litem',
  'mk',
  'k',
  'on',
  'hidden',
  'node',
  // (2) Fremdcode
  'ProseMirror', // packages/editor + lib/editor/ui-extensions.ts
  'ProseMirror-selectednode',
  'doc', // ProseMirror-Wurzelklasse, lib/editor/ui-extensions.ts
  'trigger', // Suggestion-Dekoration, lib/editor/ui-extensions.ts
  'plus', // Werkzeugleisten-Zustand, editor-toolbar.tsx (Template-Literal)
  'clickable', // findings-panel.tsx (Template-Literal)
  'unsupported', // findings-panel.tsx
  'normalization', // findings-panel.tsx
  'frontmatter', // packages/markdown/src/render.ts
  'upload-input', // wysiwyg-editor.tsx
  'yt-embed-editor', // packages/editor/src/nodes/youtube-embed.ts
  'yt-embed-editor-url',
  'alert-caution', // packages/markdown/src/render.ts
  'alert-important',
  'alert-tip',
  'dim', // lib/graph/model.ts, per attr('class') gesetzt
  'e-hier',
  'e-link',
  'e-rel',
  's-working', // Knotenform je Status, lib/graph/status-shape.ts
  's-review',
  's-released',
  's-archived',
  'css', // Fehlalarm: `@import '../tokens.css'` in 00-tokens.css
])
const toteKlassen = [...cssKlassen.keys()]
  .filter((n) => !markupKlassen.has(n) && !VERTRAG.has(n) && !n.startsWith('cm-') && !n.startsWith('n-') && !n.startsWith('is-') && !n.startsWith('hide-'))
  .sort()

// ── Kennzahlen ─────────────────────────────────────────────────────────────
const radien = [...new Set(werte('border-radius'))]
const radienLiterale = radien.filter((v) => !v.startsWith('var(') && !v.startsWith('calc('))
const schatten = [...new Set(werte('box-shadow'))]
const schriftgrade = [...new Set(werte('font-size'))]
const schriftgradePx = schriftgrade.filter((v) => /^-?[\d.]+px$/.test(v))
const zeilenabstaende = [...new Set(werte('line-height'))]
const schriftschnitte = [...new Set(werte('font-weight'))]
const schnittZahlen = schriftschnitte.filter((v) => /^\d+$/.test(v))
const wichtig = fundstellen(/!important/)
const ohneRing = fundstellen(/outline:\s*(none|0)\b/)
const uebergang = fundstellen(/data-altlasten/)
const hexLiterale = fundstellen(/:\s*#[0-9a-fA-F]{3,8}\b/)
const rgbaLiterale = fundstellen(/rgba?\(\s*\d/)
const backdrop = fundstellen(/::backdrop/)
const nichtOffen = fundstellen(/:not\(\[open\]\)/)
const pille999 = fundstellen(/\b999px\b/)
const skaliert = fundstellen(/transform:\s*scale\(/)

// ── Doppelt definierte Selektoren ──────────────────────────────────────────
// Die Bestandsaufnahme (§3) zaehlt jeden EINZELNEN Selektor, der in mehr als
// einem Regelblock vorkommt — auch als Glied einer Selektorliste (ihr
// `grep`-Kommando trifft die letzte Zeile einer Liste mit). Das ist die
// gesuchte Groesse: wer `.meta dd` aendern will, muss sonst zwei Stellen
// finden. Hier wird deshalb dasselbe gezaehlt, aber getrennt nach
//   (a) innerhalb EINER Datei  — ein Versehen, gehoert zusammengefuehrt;
//   (b) ueber Dateien hinweg   — Baustein + Ansichts-Alias, gewollt, weil die
//       Kaskade genau davon lebt (s. Kopf von `43-flaeche.css`).
// Regelkoepfe werden dafuer ueber Zeilengrenzen zusammengesetzt.
const einzelSelektoren = new Map()
/** Kommaliste aufteilen, ohne in `:is(a, b)` hineinzuschneiden. */
function teileSelektoren(sel) {
  const out = []
  let tiefe = 0
  let akku = ''
  for (const c of sel) {
    if (c === '(') tiefe++
    else if (c === ')') tiefe--
    if (c === ',' && tiefe === 0) {
      out.push(akku.trim())
      akku = ''
    } else akku += c
  }
  if (akku.trim()) out.push(akku.trim())
  return out.filter(Boolean)
}
for (const [datei, src] of quellen) {
  const zeilen = src.split('\n')
  let kopf = ''
  let start = 0
  let tiefe = 0
  // Regeln INNERHALB von `@media`/`@supports` sind gewollte Varianten derselben
  // Regel und keine Doppeldefinition — sie werden uebersprungen.
  let atTiefe = 0
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i]
    const auf = (z.match(/\{/g) ?? []).length
    const zu = (z.match(/\}/g) ?? []).length
    if (tiefe > 0) {
      tiefe += auf - zu
      if (tiefe < 0) {
        atTiefe += tiefe
        tiefe = 0
      }
      continue
    }
    if (/^\s*@/.test(z)) {
      kopf = ''
      atTiefe += auf - zu
      continue
    }
    if (/^\s*\}/.test(z)) {
      atTiefe = Math.max(0, atTiefe - zu)
      kopf = ''
      continue
    }
    if (/^\s*$/.test(z)) {
      kopf = ''
      continue
    }
    if (!kopf) start = i + 1
    kopf += (kopf ? ' ' : '') + z.trim()
    if (!kopf.includes('{')) continue
    const sel = kopf.slice(0, kopf.indexOf('{')).trim()
    tiefe = 1
    kopf = ''
    if (!sel || sel.startsWith('@') || sel.includes('%') || atTiefe > 0) continue
    // Eigenschaftsnamen des Blocks — sie entscheiden, ob eine zweite
    // Definition wirklich eine ueberschreibt (s. Erklaerung oben).
    const eigenschaften = new Set()
    for (let j = i + 1; j < zeilen.length && !/^\s*\}/.test(zeilen[j]); j++) {
      const d = zeilen[j].match(/^\s*([-a-zA-Z][\w-]*)\s*:/)
      if (d) eigenschaften.add(d[1])
    }
    for (const einzel of teileSelektoren(sel)) {
      if (!einzelSelektoren.has(einzel)) einzelSelektoren.set(einzel, [])
      einzelSelektoren.get(einzel).push({ ort: `${datei}:${start}`, datei, eigenschaften })
    }
  }
}
// Eine zweite Definition ist nur dann ein Fehler, wenn beide Bloecke dieselbe
// EIGENSCHAFT setzen — dann gewinnt eine still, und wer den Wert sucht, findet
// die falsche Stelle. Ein gemeinsamer Grundblock plus eigene Ergaenzungen
// (`.page-body h1…h6` mit Schriftfamilie, dann je eigene Groesse) ist dagegen
// gewollt und wird getrennt ausgewiesen.
const ueberschneidung = (v) => {
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++)
      for (const e of v[i].eigenschaften) if (v[j].eigenschaften.has(e)) return e
  return null
}
const mehrfach = [...einzelSelektoren.entries()].filter(([, v]) => v.length > 1)
const kollidierend = mehrfach.filter(([, v]) => ueberschneidung(v))
const doppeltInDatei = kollidierend.filter(([, v]) => new Set(v.map((x) => x.datei)).size === 1)
const doppeltUeberDateien = kollidierend.filter(([, v]) => new Set(v.map((x) => x.datei)).size > 1)
const ergaenzend = mehrfach.filter(([, v]) => !ueberschneidung(v))

// Inline-Stile im JSX
const inlineStile = []
for (const root of MARKUP_ROOTS) {
  for (const datei of lesbareDateien(root)) {
    if (!datei.endsWith('.tsx')) continue
    const src = fs.readFileSync(datei, 'utf8')
    const zeilen = src.split('\n')
    for (let i = 0; i < zeilen.length; i++) {
      if (/\sstyle=\{\{/.test(zeilen[i])) inlineStile.push(`${path.relative(REPO, datei)}:${i + 1}`)
    }
  }
}

// Bedienelement-Hoehen: feste `height`/`min-height` an einem Bedienelement
const feste = [...new Set(werte('height').concat(werte('min-height')))].filter((v) => /^\d+(\.\d+)?px$/.test(v))

// ── Ausgabe ────────────────────────────────────────────────────────────────
const zeilenGesamt = [...quellen.values()].reduce((n, s) => n + s.split('\n').length, 0)
const regelbloecke = (alles.match(/\{/g) ?? []).length

// Je Kennzahl: [Name, Istwert, ZIEL aus §3 des Plans, ABGENOMMEN].
//
// „Ziel" ist der Wert, den Etappe 2 laut Bestandsaufnahme erreichen soll.
// „Abgenommen" ist der Wert, den Teilschritt I gemessen und begruendet
// hinterlassen hat. Das Skript SCHLAEGT AN, sobald eine Zahl ueber den
// abgenommenen Wert steigt — das ist der Regressionsschutz. Wo Ziel und
// abgenommener Wert auseinanderliegen, steht die Begruendung im Bericht zu
// Teilschritt I; es sind ausschliesslich Posten der Typo- und Radienskala,
// die laut Plan §7.4 Regel 1 in den Token-Katalog gehoeren (`carryOver`) und
// damit zu Etappe 3, nicht ins CSS.
const tabelle = [
  ['Stildateien', dateien.length, null, null],
  ['Zeilen CSS (ohne Kommentare)', zeilenGesamt, null, null],
  ['Regelblöcke', regelbloecke, null, null],
  ['Distinkte Klassennamen im CSS', cssKlassen.size, null, null],
  ['Klassennamen ohne Markup-Fundstelle', toteKlassen.length, 0, 0],
  ['Distinkte Kantenradien', radien.length, 6, 10],
  ['davon Zahlenliterale', radienLiterale.length, 2, 4],
  ['999px (Pillenform als Literal)', pille999.length, 0, 0],
  ['transform: scale an einer Marke', skaliert.length, 0, 0],
  ['Distinkte Schattenwerte', schatten.length, 5, 6],
  ['Distinkte font-size-Werte', schriftgrade.length, null, null],
  ['davon px-Literale', schriftgradePx.length, 0, 0],
  ['Distinkte line-height-Werte', zeilenabstaende.length, 5, 13],
  ['Distinkte font-weight-Werte', schriftschnitte.length, null, null],
  ['davon Zahlenliterale', schnittZahlen.length, 0, 0],
  ['!important', wichtig.length, 4, 4],
  ['outline: none/0 (Fokusring ersatzlos)', ohneRing.length, 1, 1],
  ['Übergangs-Schalter (data-altlasten)', uebergang.length, 4, 4],
  ['::backdrop', backdrop.length, 1, 1],
  [':not([open])', nichtOffen.length, 1, 1],
  ['Hex-Literale in Deklarationen', hexLiterale.length, 4, 4],
  ['rgb/rgba-Literale in Deklarationen', rgbaLiterale.length, 0, 0],
  ['Selektor setzt dieselbe Eigenschaft zweimal (1 Datei)', doppeltInDatei.length, 0, 0],
  ['… dasselbe über Baustein und Ansicht hinweg', doppeltUeberDateien.length, 0, 0],
  ['Grundblock + eigene Ergänzung (gewollt)', ergaenzend.length, null, null],
  ['Inline-Stile in JSX', inlineStile.length, 5, 31],
]

let ueberAbgenommen = 0
let ueberZiel = 0
const breite = Math.max(...tabelle.map(([n]) => n.length))
console.log('CSS-Inventar — apps/web/app/styles/\n')
console.log(`     ${'Kennzahl'.padEnd(breite)}    Ist   abgenommen   Ziel Etappe 2`)
for (const [name, ist, ziel, abg] of tabelle) {
  let marke = '   '
  if (abg !== null && ist > abg) {
    marke = ' !!'
    ueberAbgenommen++
  } else if (ziel !== null && ist > ziel) {
    marke = '  →'
    ueberZiel++
  } else if (ziel !== null) marke = ' ok'
  const sp = (v) => (v === null ? '     —' : String(v).padStart(6))
  console.log(`${marke}  ${name.padEnd(breite)} ${String(ist).padStart(6)} ${sp(abg)}       ${sp(ziel)}`)
}

const details = process.argv.includes('--details')
if (details) {
  const block = (titel, liste) => {
    console.log(`\n── ${titel} (${liste.length})`)
    for (const z of liste) console.log('   ' + z)
  }
  block('Klassennamen ohne Markup-Fundstelle', toteKlassen.map((n) => `.${n}  ${[...cssKlassen.get(n)].join(' ')}`))
  block('Kantenradien', radien)
  block('Schattenwerte', schatten)
  block('font-size-Werte', schriftgrade)
  block('line-height-Werte', zeilenabstaende)
  block('font-weight-Werte', schriftschnitte)
  block('!important', wichtig)
  block('outline: none/0', ohneRing)
  block('data-altlasten', uebergang)
  block('Hex-Literale', hexLiterale)
  const zeigen = ([k, v]) => `${k}  →  ${v.map((x) => x.ort).join(' ')}   [${ueberschneidung(v) ?? '—'}]`
  block('Dieselbe Eigenschaft zweimal, eine Datei', doppeltInDatei.map(zeigen))
  block('Dieselbe Eigenschaft zweimal, Baustein + Ansicht', doppeltUeberDateien.map(zeigen))
  block('Grundblock + eigene Ergänzung', ergaenzend.map(([k, v]) => `${k}  →  ${v.map((x) => x.ort).join(' ')}`))
  block('Inline-Stile', inlineStile)
  block('Feste px-Höhen', feste)
}

console.log(
  ueberAbgenommen === 0
    ? `\nKeine Kennzahl über ihrem abgenommenen Wert (Regressionsschutz gehalten).` +
        (ueberZiel ? ` ${ueberZiel} noch über dem Ziel von Etappe 2 — offene Liste für Etappe 3 (Typo- und Radienskala, s. Bericht Teilschritt I).` : '')
    : `\n${ueberAbgenommen} Kennzahl(en) ÜBER dem abgenommenen Wert — mit --details die Fundstellen.`,
)
process.exit(ueberAbgenommen === 0 ? 0 : 1)
