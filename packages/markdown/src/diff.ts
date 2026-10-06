import { unified } from 'unified'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import type { Options as SanitizeSchema } from 'rehype-sanitize'
import { diffLines, diffWordsWithSpace } from 'diff'
import { splitFrontmatter } from './frontmatter-split.js'
import { parseMarkdownTree, stringifyMarkdown } from './stringify.js'
import { baseSanitizeSchema, renderHtml } from './render.js'
import type { RenderOptions } from './render.js'
import type { MdastRoot } from './types.js'

/**
 * Diff-Engine (Phase 2d Task 4): vergleicht zwei Markdown-Stände (main vs. Draft-Branch)
 * blockweise und liefert ein fertig gerendertes, sanitisiertes visuelles Diff plus eine
 * reine Zeilen-Sicht für den "Markdown"-Tab. Arbeitet bewusst auf den ROHEN
 * Markdown-Ständen, nicht auf bereits gerenderten HTML-Ständen (siehe Brief: der
 * Draft-Index existiert erst nach dem ersten Save, sein HTML ist mit einem
 * Ein-Seiten-Resolver gebaut) — jeder Block wird HIER über die geteilte Pipeline
 * (`parseMarkdownTree`/`stringifyMarkdown`/`renderHtml`) selbst gerendert.
 *
 * Algorithmus (Block-Ebene): Frontmatter wird abgetrennt (`splitFrontmatter`) und bei
 * Abweichung als eigener synthetischer `changed`-Block VOR dem Body ausgeliefert. Die
 * Bodies werden geparst (`parseMarkdownTree`), die TOP-LEVEL-Kinder einzeln über
 * `stringifyMarkdown` kanonisiert ("Block-String") und per LCS (Longest Common
 * Subsequence) über diese Strings verglichen — identische Block-Strings sind `same`.
 * Die verbleibenden, nicht gematchten Blöcke zwischen zwei Matches werden PAARWEISE
 * (alt[i] <-> neu[i], in Dokumentreihenfolge) als `changed` behandelt; ein Überhang auf
 * einer Seite wird `removed` bzw. `added`. Für ein `changed`-Paar aus zwei Absätzen gibt
 * es einen Wort-Diff, für zwei Tabellen einen Zellvergleich — jeder andere `changed`-Typ
 * (Codeblock, Alert/Blockquote, Liste, Heading, …) wird als `removed`+`added`-Paar
 * ausgeliefert (zwei separate `DiffBlock`s statt eines `changed`-Blocks).
 *
 * Sanitizing: JEDES ausgelieferte HTML-Fragment läuft durch einen Sanitizer, auch die
 * DREI Sonderpfade, deren HTML NICHT ausschließlich `renderHtml` durchlaufen hat
 * (Wort-Diff-Absätze, Tabellen-Zellvergleich-Postprocessing, Frontmatter-Roh-Block) —
 * siehe `sanitizeFragment` unten. `same`/`added`/`removed`-Blöcke nutzen unverändert
 * `renderHtml` mit dem NORMALEN Seiten-Sanitize-Schema aus render.ts (das bleibt
 * unangetastet); nur die drei Sonderpfade hier nutzen ein eigenes, erweitertes Schema
 * (`diffSanitizeSchema`, ins/del/Diff-Klassen/`data-diff`), das render.ts NICHT
 * beeinflusst.
 */

// --- Öffentlicher Vertrag (Brief, wörtlich) ----------------------------------------

export interface DiffBlock {
  kind: 'same' | 'added' | 'removed' | 'changed'
  /** Fertig gerendertes, sanitisiertes HTML-Fragment. `same`/`added`/`removed` sind
   *  UNGEWRAPPT — der Konsument (Frontend) legt je nach `kind` den `.dchange.add`-/
   *  `.dchange.rm`-Wrapper (bzw. ein `<details>` für `removed`) selbst darum. */
  html: string
  /** Rail-Sprungmarke, `c1..cN` in Ausgabereihenfolge (JEDER Block bekommt eine,
   *  nicht nur geänderte — einfacher, deterministischer Vertrag für den Konsumenten). */
  anchor: string
}

export interface MdDiffLine {
  kind: 'same' | 'add' | 'rm'
  text: string
}

export interface MarkdownDiff {
  blocks: DiffBlock[]
  summary: { added: number; changed: number; removed: number }
  mdLines: MdDiffLine[]
}

export interface DiffMarkdownOptions {
  /** Wie `RenderOptions.resolveLink`, aber optional: Default markiert jeden Wikilink/
   *  relativen Link in `same`/`added`/`removed`-Blöcken als `broken-link` (Erster-Run-
   *  Vereinfachung — der Diff kennt ohne übergebenen Resolver den Seitengraph nicht;
   *  siehe README). Greift NICHT im Wort-Diff (der zeigt die Markdown-QUELLE, keinen
   *  aufgelösten Link). */
  resolveLink?: RenderOptions['resolveLink']
  resolveImage?: RenderOptions['resolveImage']
}

// --- Intern: Block ohne Anchor (wird erst nach dem vollständigen Aufbau vergeben) --

interface DraftBlock {
  kind: DiffBlock['kind']
  html: string
}

// --- Lokale, minimale mdast-Node-Typen (analog zu parse.ts/render.ts/stringify.ts) -

interface BlockNode {
  type: string
}

interface ParagraphNode extends BlockNode {
  type: 'paragraph'
}

interface TableCellNode {
  type: 'tableCell'
  children?: unknown[]
}

interface TableRowNode {
  type: 'tableRow'
  children?: TableCellNode[]
}

interface TableNode extends BlockNode {
  type: 'table'
  children?: TableRowNode[]
}

// --- Sanitize-Schema für die drei Sonderpfade (NICHT das Seiten-Schema aus render.ts) -
//
// Klont `baseSanitizeSchema` (render.ts, Task 4 export) und erweitert die Kopie um
// ins/del (Wort-Diff), td/th/tr (Tabellen-Zellvergleich: cell-chg/cell-add/row-add),
// span (cellflag-Badge), pre/div (Frontmatter-Roh-Block) — jeweils className + das
// generische `dataDiff`-Attribut (`data-diff="…"`, Programmier-Hook neben der
// CSS-Klasse). `ins`/`del` stehen schon in `defaultSchema.tagNames` (GitHub-Stil) — nur
// die Attribute fehlen.
type AttributeEntry = string | [string, ...Array<string | number | boolean | RegExp | null | undefined>]

/** `hast-util-sanitize`s `findDefinition` nimmt für einen Property-Namen IMMER nur den
 *  ERSTEN Treffer in der Attributliste (kein Merge von Haus aus) — ein zweites
 *  `['className', …]`-Tupel für dieselbe Property (z. B. weil `div`/`span` in
 *  `baseSanitizeSchema` schon eines tragen: Alert-Klassen bzw. `broken-link`) würde
 *  sonst klanglos IGNORIERT, nicht etwa zusammengeführt. Diese Hilfsfunktion merged
 *  daher explizit in ein evtl. vorhandenes `className`-Tupel hinein, statt ein zweites
 *  danebenzustellen.
 */
function withMergedClassNames(list: AttributeEntry[] | undefined, extra: string[]): AttributeEntry[] {
  const next = [...(list ?? [])]
  const index = next.findIndex((entry) => Array.isArray(entry) && entry[0] === 'className')
  if (index === -1) {
    next.push(['className', ...extra])
    return next
  }
  const existing = next[index] as [string, ...string[]]
  next[index] = ['className', ...existing.slice(1), ...extra]
  return next
}

const diffSanitizeSchema: SanitizeSchema = (() => {
  const base = structuredClone(baseSanitizeSchema)
  const attrs = (base.attributes ?? {}) as Record<string, AttributeEntry[]>
  base.attributes = {
    ...attrs,
    ins: [...withMergedClassNames(attrs.ins, ['add']), 'dataDiff'],
    del: [...withMergedClassNames(attrs.del, ['rm']), 'dataDiff'],
    td: [...withMergedClassNames(attrs.td, ['cell-chg', 'cell-add']), 'dataDiff'],
    th: [...withMergedClassNames(attrs.th, ['cell-chg', 'cell-add']), 'dataDiff'],
    tr: [...withMergedClassNames(attrs.tr, ['row-add']), 'dataDiff'],
    span: [...withMergedClassNames(attrs.span, ['cellflag']), 'dataDiff'],
    pre: [...withMergedClassNames(attrs.pre, ['diff-frontmatter', 'rm', 'add'])],
    div: [...withMergedClassNames(attrs.div, ['diff-frontmatter', 'fn-def'])],
    sup: [...withMergedClassNames(attrs.sup, ['fn-ref'])],
  }
  return base
})()

// --- Fragment-Sanitizer für hand-gebaute HTML-Strings ------------------------------
//
// Genutzt für ALLES, was diff.ts selbst als HTML-String zusammensetzt (Wort-Diff,
// Frontmatter-Roh-Block, Tabellen-Postprocessing-Ergebnis) — NIE direkt ausgeliefert.
// `rehypeRaw` reparst den String vollständig über parse5 (derselbe Mechanismus, den
// render.ts für eingebettetes Inline-HTML nutzt) — ECHTE Tags/Attribute (nicht
// vorher escaped) werden dadurch zu echten hast-Knoten und laufen anschließend durch
// denselben Sanitizer wie eine normale Seite (plus die obige Erweiterung). Text, der
// VOR dem Zusammenbau escaped wurde (siehe `escapeHtml`), bleibt dabei garantiert
// Text — parse5 interpretiert eine bereits als Entity geschriebene spitze Klammer
// nicht erneut als Tag-Start.
const fragmentProcessor = unified().use(rehypeRaw).use(rehypeSanitize, diffSanitizeSchema).use(rehypeStringify)

function sanitizeFragment(html: string): string {
  const root = { type: 'root', children: [{ type: 'raw', value: html }] }
  const sanitized = fragmentProcessor.runSync(root as never)
  return String(fragmentProcessor.stringify(sanitized as never))
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// --- Kanonischer Block-String -------------------------------------------------------

/** Serialisiert einen einzelnen mdast-Top-Level-Knoten kanonisch (wie `stringifyMarkdown`,
 *  aber für genau EINEN Knoten statt eines ganzen Baums) — die Vergleichsgrundlage für
 *  den Block-LCS und die Eingabe für `renderHtml`/den Wort-Diff. */
function canonicalBlockString(node: unknown): string {
  return stringifyMarkdown({ type: 'root', children: [node] } as MdastRoot)
}

// --- Rendering a single block (footnotes) -------------------------------------------
//
// Blocks are rendered one by one, so a `[^1]` reference has no definition in its own
// document (renders as literal text) and a definition block renders empty. Blocks that
// contain footnote nodes are therefore rendered differently: each reference becomes a
// private-use placeholder text, the block goes through `renderHtml` as usual, and the
// placeholders are then replaced by `<sup class="fn-ref">LABEL</sup>`. A top-level
// definition renders its children as a small document inside
// `<div class="fn-def"><sup>LABEL</sup> …</div>`. Placeholders instead of mdast `html`
// nodes because `renderHtml`'s page sanitizer would drop the diff-only classes; the
// result goes through `sanitizeFragment` (diff schema) like the other hand-built HTML.
// Labels are escaped before insertion.

interface FootnoteMdNode {
  type: string
  identifier?: string
  label?: string | null
  children?: unknown[]
}

const FN_REF_PLACEHOLDER = /(\d+)/g

function containsFootnote(node: unknown): boolean {
  const n = node as FootnoteMdNode
  if (n.type === 'footnoteReference' || n.type === 'footnoteDefinition') return true
  return Array.isArray(n.children) && n.children.some(containsFootnote)
}

function footnoteLabel(node: FootnoteMdNode): string {
  return node.label ?? node.identifier ?? ''
}

/** Returns a copy of `node` with every footnoteReference replaced by a placeholder
 *  text node; the labels are collected in `labels` (placeholder index = array index). */
function replaceFootnoteRefs(node: unknown, labels: string[]): unknown {
  const n = node as FootnoteMdNode
  if (n.type === 'footnoteReference') {
    labels.push(footnoteLabel(n))
    return { type: 'text', value: `${labels.length - 1}` }
  }
  if (!Array.isArray(n.children)) return node
  return { ...n, children: n.children.map((child) => replaceFootnoteRefs(child, labels)) }
}

function renderBlockHtml(node: BlockNode, renderOpts: RenderOptions): string {
  if (!containsFootnote(node)) return renderHtml(canonicalBlockString(node), renderOpts)

  const labels: string[] = []
  const replaced = replaceFootnoteRefs(node, labels) as FootnoteMdNode
  let html: string
  if (replaced.type === 'footnoteDefinition') {
    const inner = renderHtml(
      stringifyMarkdown({ type: 'root', children: replaced.children ?? [] } as MdastRoot),
      renderOpts,
    )
    html = `<div class="fn-def"><sup>${escapeHtml(footnoteLabel(replaced))}</sup> ${inner}</div>`
  } else {
    html = renderHtml(canonicalBlockString(replaced), renderOpts)
  }
  html = html.replace(FN_REF_PLACEHOLDER, (match, index: string) => {
    const label = labels[Number(index)]
    return label === undefined ? match : `<sup class="fn-ref">${escapeHtml(label)}</sup>`
  })
  return sanitizeFragment(html)
}

// --- Block-LCS -----------------------------------------------------------------------

/** Längste gemeinsame Teilfolge (Index-Paare, in Dokumentreihenfolge) über zwei
 *  Block-String-Arrays — Standard-DP, deterministisch (bei gleich langen Alternativen
 *  wird stets zuerst der ALTE Index vorangetrieben, siehe Schleife unten). O(n·m), für
 *  die realistische Blockzahl einer Wiki-Seite unproblematisch. */
function computeLcsPairs(oldItems: readonly string[], newItems: readonly string[]): Array<[number, number]> {
  const n = oldItems.length
  const m = newItems.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldItems[i] === newItems[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldItems[i] === newItems[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

// --- Wort-Diff (Absatz <-> Absatz) ---------------------------------------------------

/** Wort-Diff über die kanonische Markdown-QUELLE beider Absätze (Erster-Run-
 *  Vereinfachung, siehe README: innerhalb geänderter Absätze erscheint die
 *  Markdown-Quelle statt gerendertem Rich-Text — Formatierungsänderungen wie
 *  `**fett**` bleiben dadurch als Diff sichtbar, statt in gerendertes Fett zu
 *  verschwinden). Segmenttext wird VOR dem Zusammenbau escaped (`escapeHtml`) — ein
 *  Absatz, der zufällig wie ein Tag aussieht (z. B. Inline-HTML im Quelltext), bleibt
 *  dadurch sichtbarer Text statt von `sanitizeFragment`s Reparse als Element
 *  interpretiert und ggf. entfernt zu werden. */
function buildParagraphWordDiffHtml(oldNode: ParagraphNode, newNode: ParagraphNode): string {
  const oldSrc = canonicalBlockString(oldNode).replace(/\n+$/, '')
  const newSrc = canonicalBlockString(newNode).replace(/\n+$/, '')

  const segmentsHtml = diffWordsWithSpace(oldSrc, newSrc)
    .map((part) => {
      const text = escapeHtml(part.value)
      if (part.added) return `<ins class="add" data-diff="add">${text}</ins>`
      if (part.removed) return `<del class="rm" data-diff="rm">${text}</del>`
      return text
    })
    .join('')

  return sanitizeFragment(`<p>${segmentsHtml}</p>`)
}

// --- Tabellen-Zellvergleich (Tabelle <-> Tabelle) ------------------------------------

/** Kanonisches Inline-Markdown des Zellinhalts (Zell-Kinder in einen Absatz gepackt,
 *  damit `stringifyMarkdown` sie als Fließtext statt als eigenständigen Block
 *  serialisiert) — die Vergleichsgrundlage für den Zellvergleich, NICHT das
 *  gerenderte HTML. */
function canonicalCellString(cell: TableCellNode): string {
  const paragraph = { type: 'paragraph', children: cell.children ?? [] }
  return canonicalBlockString(paragraph).trim()
}

function extractTableCellStrings(table: TableNode): string[][] {
  return (table.children ?? []).map((row) => (row.children ?? []).map(canonicalCellString))
}

type CellKind = 'same' | 'cell-chg' | 'cell-add'

/**
 * Zeichen der Zellmarke, je Art EIN eigenes.
 *
 * Warum es das überhaupt gibt: Die Marke war bis dahin ein LEERES, per
 * `aria-hidden` verstecktes `<span>`. Damit trennte „hinzugefügt" von
 * „geändert" in der Tabelle ausschließlich die FARBE (grün gegen bernstein,
 * bei identischem 3-px-Randbalken und identischer 8-px-Marke), und
 * Vorlesesoftware bekam nichts — ein doppelter Bruch der zugesicherten
 * Eigenschaft 3 der Erscheinungsbild-Spec („Statusfarben tragen immer
 * zusätzlich Zeichen und Wort"), gemessen und gemeldet in
 * `apps/web/app/styles/63-review.css`.
 *
 * Das Zeichen ist ECHTER Textinhalt, nicht `content` einer CSS-Regel: Text,
 * den nur das Stylesheet kennt, steht nicht im Zugänglichkeitsbaum. Das
 * `aria-hidden` ist deshalb entfallen.
 *
 * Warum hier kein ausgeschriebenes Wort steht: Dieses Paket kennt keine
 * Sprache — es gibt keinen Übersetzer und keinen Locale-Parameter, weder in
 * `diffMarkdown` noch im Aufrufer (`apps/api/src/routes/workflow.ts`, GET
 * /review, wertet kein `Accept-Language` aus). Ein deutsches Wort hier wäre
 * in der englischen Oberfläche falsch. Das Wort steht stattdessen dort, wo die
 * Sprache bekannt ist: in der lokalisierten Diff-Legende
 * (`apps/web/components/review/diff-view.tsx`), die genau diese zwei Zeichen
 * neben ihre ausgeschriebene Bedeutung stellt.
 */
const CELL_FLAG_GLYPH: Record<Exclude<CellKind, 'same'>, string> = {
  'cell-add': '+',
  'cell-chg': '~',
}
type RowPlan = { kind: 'row-add' } | { kind: 'row-normal'; cellKinds: CellKind[] }

/** Reiner Zellvergleichs-Plan (Zeilen-/Spaltenindex-Abgleich, KEINE Umordnungserkennung
 *  — Erster-Run-Vereinfachung wie beim Block-LCS): Zeile fehlt auf der alten Seite ->
 *  komplett `row-add`; sonst je Spalte `cell-add` (Spalte existierte in der alten Zeile
 *  nicht) oder `cell-chg` (Text weicht ab) oder `same`. */
function buildRowPlans(oldRows: readonly string[][], newRows: readonly string[][]): RowPlan[] {
  return newRows.map((newRow, rowIndex): RowPlan => {
    const oldRow = oldRows[rowIndex]
    if (!oldRow) return { kind: 'row-add' }
    const cellKinds = newRow.map((cellMd, cellIndex): CellKind => {
      const oldCell = oldRow[cellIndex]
      if (oldCell === undefined) return 'cell-add'
      return cellMd === oldCell ? 'same' : 'cell-chg'
    })
    return { kind: 'row-normal', cellKinds }
  })
}

// Matcht je ein komplettes <tr>...</tr> (nicht verschachtelt — bei einer über
// `renderHtml` erzeugten GFM-Tabelle enthalten Zellen laut CommonMark nur Inline-Inhalt,
// also nie ein eigenes <tr>/<td>) bzw. <td>/<th>...</td|th> INNERHALB einer Zeile.
const TR_BLOCK = /<tr(\s[^>]*)?>([\s\S]*?)<\/tr>/g
const CELL_BLOCK = /<(td|th)(\s[^>]*)?>([\s\S]*?)<\/\1>/g

function withDiffAttrs(existingAttrs: string | undefined, kind: string): string {
  return `${existingAttrs ?? ''} class="${kind}" data-diff="${kind}"`
}

/** Postprocessing auf dem SELBST gerenderten (und bereits sanitisierten) HTML der neuen
 *  Tabelle — "kontrolliert, kein fremdes HTML" (Brief): die injizierten Attributwerte
 *  sind eine feste Werteliste (nie aus Zellinhalt abgeleitet), der Inhalt der
 *  eingefügten Badges ist eines von zwei festen Zeichen ({@link CELL_FLAG_GLYPH}, weder
 *  `<` noch `&`). Findet der Scanner mehr `<tr>` als der Plan kennt (defensiv,
 *  sollte bei einer selbst erzeugten Tabelle nicht vorkommen), bleibt die überzählige
 *  Zeile unverändert stehen statt zu crashen. */
function injectTableDiffAttributes(html: string, rowPlans: readonly RowPlan[]): string {
  let rowIndex = 0
  return html.replace(TR_BLOCK, (trFull, trAttrs: string | undefined, trInner: string) => {
    const plan = rowPlans[rowIndex]
    rowIndex += 1
    if (!plan) return trFull

    if (plan.kind === 'row-add') {
      return `<tr${withDiffAttrs(trAttrs, 'row-add')}>${trInner}</tr>`
    }

    let cellIndex = 0
    const newInner = trInner.replace(CELL_BLOCK, (cellFull, tag: string, cellAttrs: string | undefined, cellInner: string) => {
      const cellKind = plan.cellKinds[cellIndex]
      cellIndex += 1
      if (!cellKind || cellKind === 'same') return cellFull
      const badge = `<span class="cellflag" data-diff="${cellKind}">${CELL_FLAG_GLYPH[cellKind]}</span>`
      return `<${tag}${withDiffAttrs(cellAttrs, cellKind)}>${badge}${cellInner}</${tag}>`
    })
    return `<tr${trAttrs ?? ''}>${newInner}</tr>`
  })
}

function buildTableCellDiffHtml(oldTable: TableNode, newTable: TableNode, renderOpts: RenderOptions): string {
  const rendered = renderBlockHtml(newTable, renderOpts)
  const rowPlans = buildRowPlans(extractTableCellStrings(oldTable), extractTableCellStrings(newTable))
  return sanitizeFragment(injectTableDiffAttributes(rendered, rowPlans))
}

// --- Frontmatter-Synthetik-Block -----------------------------------------------------

/** Roh-Darstellung beider Frontmatter-Stände (kein YAML-Diff, Erster-Run-Vereinfachung
 *  wie der Absatz-Wort-Diff) — je ein `<pre>` mit dem unveränderten Frontmatter-Text
 *  (inkl. `---`-Zäunen, siehe `splitFrontmatter`). Leerer Stand (kein Frontmatter auf
 *  dieser Seite) rendert als leeres `<pre>`. */
function buildFrontmatterDiffBlock(oldRaw: string, newRaw: string): DraftBlock {
  const html =
    '<div class="diff-frontmatter">'
    + `<pre class="diff-frontmatter rm"><code>${escapeHtml(oldRaw)}</code></pre>`
    + `<pre class="diff-frontmatter add"><code>${escapeHtml(newRaw)}</code></pre>`
    + '</div>'
  return { kind: 'changed', html: sanitizeFragment(html) }
}

// --- Block-Zusammenbau (LCS-Lücken -> removed/added/changed) ------------------------

/** Ein `changed`-Paar liefert GENAU einen `DiffBlock` für Absatz<->Absatz (Wort-Diff)
 *  und Tabelle<->Tabelle (Zellvergleich), sonst ZWEI (`removed` gefolgt von `added` —
 *  "übrige changed-Typen als removed+added-Paar", Brief wörtlich). Deshalb `DraftBlock[]`
 *  statt eines einzelnen Blocks als Rückgabetyp. */
function buildChangedBlocks(oldNode: BlockNode, newNode: BlockNode, renderOpts: RenderOptions): DraftBlock[] {
  if (oldNode.type === 'paragraph' && newNode.type === 'paragraph') {
    return [{ kind: 'changed', html: buildParagraphWordDiffHtml(oldNode as ParagraphNode, newNode as ParagraphNode) }]
  }
  if (oldNode.type === 'table' && newNode.type === 'table') {
    return [{ kind: 'changed', html: buildTableCellDiffHtml(oldNode as TableNode, newNode as TableNode, renderOpts) }]
  }
  return [
    { kind: 'removed', html: renderBlockHtml(oldNode, renderOpts) },
    { kind: 'added', html: renderBlockHtml(newNode, renderOpts) },
  ]
}

/** Baut die Blöcke einer LCS-Lücke (zwischen zwei Matches bzw. vor dem ersten/nach dem
 *  letzten): paarweise `changed` (alt[i] <-> neu[i], "benachbart alt↔neu", Brief
 *  wörtlich) für die gemeinsame Länge, ein Überhang auf der alten Seite wird `removed`,
 *  auf der neuen Seite `added`. */
function appendGapBlocks(
  out: DraftBlock[],
  oldNodes: readonly BlockNode[],
  newNodes: readonly BlockNode[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  renderOpts: RenderOptions,
): void {
  const oldCount = oldEnd - oldStart
  const newCount = newEnd - newStart
  const pairCount = Math.min(oldCount, newCount)

  for (let k = 0; k < pairCount; k++) {
    out.push(...buildChangedBlocks(oldNodes[oldStart + k], newNodes[newStart + k], renderOpts))
  }
  for (let k = pairCount; k < oldCount; k++) {
    out.push({ kind: 'removed', html: renderBlockHtml(oldNodes[oldStart + k], renderOpts) })
  }
  for (let k = pairCount; k < newCount; k++) {
    out.push({ kind: 'added', html: renderBlockHtml(newNodes[newStart + k], renderOpts) })
  }
}

// --- mdLines (voller Dokumentvergleich, Markdown-Tab) --------------------------------

/** Zerlegt einen `diffLines`-Segmentwert in einzelne Zeilen — ein abschließender
 *  Zeilenumbruch erzeugt beim Split ein leeres letztes Element, das entfernt wird (die
 *  letzte tatsächliche Zeile OHNE Zeilenumbruch am Dateiende bleibt dagegen erhalten). */
function splitIntoLines(value: string): string[] {
  const parts = value.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

function buildMdLines(oldMd: string, newMd: string): MdDiffLine[] {
  const lines: MdDiffLine[] = []
  for (const part of diffLines(oldMd, newMd)) {
    const kind: MdDiffLine['kind'] = part.added ? 'add' : part.removed ? 'rm' : 'same'
    for (const text of splitIntoLines(part.value)) {
      lines.push({ kind, text })
    }
  }
  return lines
}

// --- Öffentliche API -------------------------------------------------------------

const defaultResolveLink: RenderOptions['resolveLink'] = () => null

/**
 * Vergleicht zwei vollständige Markdown-Dokumente (main vs. Draft-Branch, jeweils
 * inkl. Frontmatter) blockweise und liefert ein fertiges visuelles Diff (`blocks`,
 * je mit sanitisiertem HTML und Rail-Anchor) plus eine reine Zeilensicht (`mdLines`)
 * für den Markdown-Tab. Wirft nie (wie `renderHtml`/`parseMarkdownTree`) — ungültige
 * Frontmatter-/Markdown-Konstrukte erscheinen einfach unverändert im Output.
 */
export function diffMarkdown(oldMd: string, newMd: string, opts: DiffMarkdownOptions = {}): MarkdownDiff {
  const renderOpts: RenderOptions = {
    resolveLink: opts.resolveLink ?? defaultResolveLink,
    resolveImage: opts.resolveImage,
  }

  const oldSplit = splitFrontmatter(oldMd)
  const newSplit = splitFrontmatter(newMd)

  const draftBlocks: DraftBlock[] = []
  if (oldSplit.frontmatterRaw !== newSplit.frontmatterRaw) {
    draftBlocks.push(buildFrontmatterDiffBlock(oldSplit.frontmatterRaw, newSplit.frontmatterRaw))
  }

  const oldNodes = (parseMarkdownTree(oldSplit.body).children ?? []) as BlockNode[]
  const newNodes = (parseMarkdownTree(newSplit.body).children ?? []) as BlockNode[]
  const oldStrings = oldNodes.map(canonicalBlockString)
  const newStrings = newNodes.map(canonicalBlockString)

  const matches = computeLcsPairs(oldStrings, newStrings)

  let prevOld = 0
  let prevNew = 0
  for (const [oi, ni] of matches) {
    appendGapBlocks(draftBlocks, oldNodes, newNodes, prevOld, oi, prevNew, ni, renderOpts)
    draftBlocks.push({ kind: 'same', html: renderBlockHtml(newNodes[ni], renderOpts) })
    prevOld = oi + 1
    prevNew = ni + 1
  }
  appendGapBlocks(draftBlocks, oldNodes, newNodes, prevOld, oldNodes.length, prevNew, newNodes.length, renderOpts)

  const blocks: DiffBlock[] = draftBlocks.map((block, index) => ({ ...block, anchor: `c${index + 1}` }))

  const summary = {
    added: blocks.filter((b) => b.kind === 'added').length,
    changed: blocks.filter((b) => b.kind === 'changed').length,
    removed: blocks.filter((b) => b.kind === 'removed').length,
  }

  return { blocks, summary, mdLines: buildMdLines(oldMd, newMd) }
}
