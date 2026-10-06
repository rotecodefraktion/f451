import { formatImageAlt, stringifyMarkdown } from '@f451/markdown'
import type { Mark, Node as PmNode } from 'prosemirror-model'
import { footnoteIdentifier } from './footnote-label.js'

// --- ProseMirror -> markdown (Task 4, Phase 2b) -------------------------------------
//
// docToMarkdown(doc) ist die INVERSE zu markdownToDoc (Task 3, from-markdown.ts): baut
// aus dem PM-Dokument denselben mdast-Baum-Vertrag, den parseMarkdownTree für
// entsprechendes Markdown erzeugen würde, und reicht ihn an stringifyMarkdown aus
// @f451/markdown weiter — KEINE eigene Stringify-Logik hier (eine Markdown-Wahrheit,
// siehe Plan-Constraint). Die Roundtrip-Suite (roundtrip.test.ts) beweist
// docToMarkdown(markdownToDoc(md)) === md byte-identisch über den gesamten
// Golden-Korpus aus @f451/markdown.
//
// Architektur: analog zu from-markdown.ts zwei kleine Handler-Maps (Block-Ebene,
// Inline-Ebene/Marks) statt einer Riesen-switch-Kaskade. Wo from-markdown einen
// mdast-Knoten in einen (oder mehrere) PM-Knoten umbaut, baut dieses Modul aus einem
// PM-Knoten ein (oder mehrere) mdast-Knoten — spiegelbildlich dieselben Entscheidungen
// (Alert<->Blockquote-Marker, Bild als eigener Block, Link literal<->Autolink,
// Wikilink value/data.alias, Tabellen-Alignment, Task-Items).

// --- Lokale, minimale mdast-Node-Typen -----------------------------------------------
//
// Analog zu from-markdown.ts: EIN großzügiges Interface für alle vorkommenden
// mdast-Knotentypen (Block UND Inline) statt einer diskriminierten Union — wir sind
// hier die ERZEUGENDE Seite, jedes Handler weiß selbst, welche Felder es für seinen
// Knotentyp setzt; ein Union-Typ würde nur Konstruktions-Overhead ohne echten
// Mehrwert erzwingen.
interface MdNode {
  type: string
  value?: string
  url?: string
  title?: string
  alt?: string
  lang?: string | null
  depth?: 1 | 2 | 3 | 4 | 5 | 6
  ordered?: boolean
  start?: number
  spread?: boolean
  checked?: boolean
  align?: Array<'left' | 'center' | 'right' | null>
  data?: { alias?: string }
  identifier?: string
  label?: string
  children?: MdNode[]
}

interface MdRootLike {
  type: 'root'
  children: MdNode[]
}

// --- Block-Ebene ----------------------------------------------------------------------

type BlockHandler = (node: PmNode) => MdNode[]

/** Wandelt die direkten Kind-Blöcke eines PM-Knotens (doc, blockquote, listItem, …) in
 *  eine flache mdast-Knotenliste um — jeder PM-Block erzeugt normalerweise genau einen
 *  mdast-Block, ein Image-Block (s. u.) wird dabei in einen eigenen paragraph-Wrapper
 *  gehüllt. */
function convertBlockChildren(parent: PmNode): MdNode[] {
  const result: MdNode[] = []
  parent.forEach((child) => {
    result.push(...convertBlock(child))
  })
  return result
}

function convertBlock(node: PmNode): MdNode[] {
  const handler = blockHandlers[node.type.name]
  if (!handler) {
    // Sollte für den unterstützten Dialekt nie eintreten (Editor-Schema deckt exakt
    // den Golden-Korpus-Umfang ab) — defensiv statt eines stillen Drops.
    throw new Error(`to-markdown: kein Block-Handler für Node-Typ "${node.type.name}"`)
  }
  return handler(node)
}

/** Bild ist in diesem Schema block-level (@tiptap/extension-image, inline: false, s.
 *  from-markdown.ts) — die Inverse macht aus einem einzelnen image-Block einen
 *  mdast-paragraph mit genau einem image-Kind (Task-Vertrag, s. Brief). Bekannte,
 *  bewusst nicht rückgebaute Lücke: markdownToDoc splittet einen gemischten
 *  Text+Bild-Absatz in mehrere PM-Blöcke (paragraph/image/paragraph) — die Inverse
 *  baut daraus KEINEN gemeinsamen mdast-Absatz zurück, sondern mehrere separate
 *  Absätze (kein Fall im Golden-Korpus, s. from-markdown.ts-Kommentar zur selben
 *  Lücke). */
function convertImageBlock(node: PmNode): MdNode[] {
  return [{ type: 'paragraph', children: [convertImage(node)] }]
}

function convertImage(node: PmNode): MdNode {
  const src = node.attrs.src as string
  const title = node.attrs.title as string | null
  // width/height wieder als Obsidian-Suffix `|W`/`|WxH` an den Alt-Text hängen
  // (Inverse zu parseImageAltSize in from-markdown → byte-identischer Roundtrip).
  const width = node.attrs.width as number | null
  const height = node.attrs.height as number | null
  const alt = formatImageAlt(node.attrs.alt as string | null, width, height)
  return {
    type: 'image',
    url: src,
    ...(alt ? { alt } : {}),
    ...(title ? { title } : {}),
  }
}

/** youtubeEmbed -> Paragraph mit einem Autolink-Literal-Kind (Inverse zu
 *  matchYoutubeParagraph/convertParagraph in from-markdown.ts). Eine Markdown-Wahrheit
 *  (Plan-Constraint): dieses Modul erzeugt bewusst KEINE nackte URL-Zeichenkette selbst
 *  (das wäre eine zweite Stelle, die "was ist eine Autolink-Literal-Zeile" kennen
 *  müsste) — stattdessen denselben mdast-'link'-Knoten mit Text === url, den
 *  isAutolinkLiteral (from-markdown.ts) erkennt und den stringifyMarkdown
 *  (@f451/markdown) als nackte Zeile serialisiert (siehe convertLink/isAutolinkLiteral-
 *  Kommentar dort für das Erkennungskriterium). node.attrs.url trägt die ORIGINAL-URL
 *  (youtu.be-Kurzform, &t=-Parameter usw.), nicht nur die Video-ID — damit bleibt der
 *  Roundtrip für jede Quellform byte-identisch. */
function convertYoutubeEmbedBlock(node: PmNode): MdNode[] {
  const url = String(node.attrs.url ?? '')
  return [
    {
      type: 'paragraph',
      children: [{ type: 'link', url, children: [{ type: 'text', value: url }] }],
    },
  ]
}

/** Alert -> Blockquote mit `[!TYP]`-Marker (Inverse zu convertBlockquote/
 *  matchAlertBlockquote in from-markdown.ts). Drei Fälle:
 *  0. `markerOwnParagraph: true` (Quellform "> [!NOTE]\n>\n> Text", von from-markdown
 *     als Attr konserviert — s. nodes/alert.ts): eigener Marker-Absatz VOR dem
 *     restlichen Inhalt, exakt die Umkehrung des Marker-only-Zweigs in
 *     matchAlertBlockquote (byte-identischer Roundtrip auch für diese Form).
 *  1. Sonst, erster Block des Alert-Inhalts ist ein NICHT-leerer paragraph: der Marker
 *     (plus '\n', da Marker und Text im Quelltext durch einen Soft-Linebreak getrennt
 *     sind, s. blockquote-alerts.md) wird in dessen ERSTES Kind hineingezogen — ist
 *     dieses Kind bereits Text, wird der Marker davorgesetzt (ein Textknoten bleibt
 *     ein Textknoten); ist es etwas anderes (z. B. ein Wikilink als erstes Wort),
 *     wird ein eigener Marker-Textknoten davor eingefügt.
 *  2. Sonst (kein Inhalt, oder der erste Block ist kein/ein leerer paragraph, z. B. ein
 *     Alert, dessen Inhalt direkt mit einer Liste beginnt): ebenfalls eigener
 *     Marker-only-Absatz — die einzige in Markdown ausdrückbare Form für diesen Inhalt. */
function convertAlert(node: PmNode): MdNode[] {
  const alertType = node.attrs.alertType as string
  const marker = `[!${alertType.toUpperCase()}]`
  const bodyBlocks = convertBlockChildren(node)
  const [first, ...rest] = bodyBlocks
  const markerOwnParagraph = node.attrs.markerOwnParagraph === true

  if (!markerOwnParagraph && first && first.type === 'paragraph' && (first.children?.length ?? 0) > 0) {
    const [firstChild, ...restChildren] = first.children!
    const newFirstChild: MdNode =
      firstChild.type === 'text'
        ? { ...firstChild, value: `${marker}\n${firstChild.value ?? ''}` }
        : { type: 'text', value: `${marker}\n` }
    const mergedChildren =
      firstChild.type === 'text' ? [newFirstChild, ...restChildren] : [newFirstChild, firstChild, ...restChildren]
    const mergedFirst: MdNode = { ...first, children: mergedChildren }
    return [{ type: 'blockquote', children: [mergedFirst, ...rest] }]
  }

  const markerParagraph: MdNode = { type: 'paragraph', children: [{ type: 'text', value: marker }] }
  return [{ type: 'blockquote', children: [markerParagraph, ...bodyBlocks] }]
}

/** Listen sind in ProseMirror weder tight noch loose — dieses Attribut kennt PM
 *  schlicht nicht. Der Golden-Korpus enthält AUSSCHLIESSLICH tight-Listen (keine
 *  Leerzeile zwischen Items, s. lists-tasks.md/mixed-document.md); ohne ein explizites
 *  `spread: false` auf list UND listItem stringifiziert remark-stringify jede Liste
 *  aber LOOSE (mdast-util-to-markdowns join-Regel behandelt ein FEHLENDES spread-Feld
 *  nicht als "false", sondern fällt auf den Blockabstand-Standard — eine Leerzeile —
 *  zurück, s. lib/join.js: `'spread' in parent` muss wahr UND boolean sein, damit
 *  0/1 statt der Standard-Leerzeile gewählt wird; empirisch gegen stringifyMarkdown
 *  verifiziert, s. Report). Deshalb: spread: false FEST für jede Liste/jedes ListItem,
 *  nicht aus dem Doc abgeleitet (der Korpus ist der Task-1-Vertrag, s. Auftrag —
 *  eine loose Liste, die dadurch tight würde, wäre ein BLOCKED-Befund, kommt im
 *  Korpus aber nicht vor). */
function convertList(node: PmNode, ordered: boolean): MdNode[] {
  const items: MdNode[] = []
  node.forEach((item) => {
    items.push({ type: 'listItem', spread: false, children: convertBlockChildren(item) })
  })
  return [
    {
      type: 'list',
      ordered,
      spread: false,
      ...(ordered ? { start: node.attrs.start as number } : {}),
      children: items,
    },
  ]
}

function convertTaskList(node: PmNode): MdNode[] {
  const items: MdNode[] = []
  node.forEach((item) => {
    items.push({
      type: 'listItem',
      spread: false,
      checked: item.attrs.checked === true,
      children: convertBlockChildren(item),
    })
  })
  return [{ type: 'list', ordered: false, spread: false, children: items }]
}

/** mdast erwartet das Alignment als Array AUF dem table-Node (ein Eintrag pro Spalte),
 *  nicht an den einzelnen Zellen (dort sitzt es im PM-Schema, s. extensions.ts). Wird
 *  aus den align-Attrs der ERSTEN Zeile (Header-Zeile) abgeleitet — die Task-3-Seite
 *  (convertTable in from-markdown.ts) schreibt align konsistent auf JEDE Zeile
 *  (Header UND Body), die Header-Zeile ist also eine gültige, vollständige Quelle. */
function convertTable(node: PmNode): MdNode[] {
  const align: Array<'left' | 'center' | 'right' | null> = []
  const rows: MdNode[] = []
  node.forEach((row, _offset, rowIndex) => {
    const cells: MdNode[] = []
    row.forEach((cell) => {
      if (rowIndex === 0) {
        align.push((cell.attrs.align as 'left' | 'center' | 'right' | null) ?? null)
      }
      // tableCell/tableHeader haben im Schema content: 'block+' (@tiptap/extension-table),
      // eine Markdown-Tabellenzelle kann aber NUR einen einzelnen Absatz darstellen —
      // die UI verhindert das Anlegen einer Mehrblock- oder Nicht-Absatz-Zelle erst ab
      // Phase 2c. Bislang las `cell.firstChild!` nur den ersten Block und verlor jeden
      // weiteren Block STILL (Befund I1, Final-Review) — Hard-Throw statt stillem
      // Verlust, analog zu den übrigen Unknown-Type-Throws in dieser Datei.
      if (cell.childCount !== 1 || cell.firstChild!.type.name !== 'paragraph') {
        throw new Error(
          `to-markdown: Tabellenzelle mit ${cell.childCount} Blöcken enthält mehr als einen Absatz oder einen ` +
            `Nicht-Absatz-Block ("${cell.firstChild?.type.name}") — das kann eine Markdown-Tabellenzelle nicht darstellen`,
        )
      }
      cells.push({ type: 'tableCell', children: convertInline(cell.firstChild!) })
    })
    rows.push({ type: 'tableRow', children: cells })
  })
  return [{ type: 'table', align, children: rows }]
}

const blockHandlers: Record<string, BlockHandler> = {
  paragraph: (node) => [{ type: 'paragraph', children: convertInline(node) }],
  heading: (node) => [
    { type: 'heading', depth: node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6, children: convertInline(node) },
  ],
  blockquote: (node) => [{ type: 'blockquote', children: convertBlockChildren(node) }],
  alert: convertAlert,
  bulletList: (node) => convertList(node, false),
  orderedList: (node) => convertList(node, true),
  taskList: convertTaskList,
  table: convertTable,
  codeBlock: (node) => [
    { type: 'code', lang: (node.attrs.language as string | null) ?? null, value: node.textContent },
  ],
  horizontalRule: () => [{ type: 'thematicBreak' }],
  image: convertImageBlock,
  youtubeEmbed: convertYoutubeEmbedBlock,
  footnoteDefinition: (node) => {
    const label = node.attrs.label as string
    const identifier = (node.attrs.identifier as string | null) ?? footnoteIdentifier(label)
    return [{ type: 'footnoteDefinition', identifier, label, children: convertBlockChildren(node) }]
  },
}

// --- Inline-Ebene / Marks --------------------------------------------------------------
//
// PM speichert Marks pro Textknoten als (nach Schema-Rang sortierte) Menge — anders als
// mdast, das Marks als VERSCHACHTELUNG abbildet (strong(emphasis(text))). Der Rückbau
// muss also aus einer flachen Folge von Textknoten (+ atomaren Inline-Knoten wie
// hardBreak/wikiLink), die jeweils ein Mark-Set tragen, wieder einen verschachtelten
// mdast-Baum erzeugen — UND dabei angrenzende Textknoten mit demselben (verbleibenden)
// Mark-Set zu einem Lauf zusammenfassen (sonst erzeugt remark-stringify z. B.
// "**fett****fett**" für zwei benachbarte, identisch markierte Textknoten statt eines
// gemeinsamen "**fettfett**").
//
// Algorithmus (peelOutermostMark): an Position i wird unter den Marks des dortigen
// Knotens diejenige gewählt, deren Deckung (zusammenhängender Lauf ab i, in dem JEDER
// Knoten dieses Mark trägt) am WEITESTEN reicht — das ist bei einer wohlgeformten
// Verschachtelung (Marks kommen aus einem Baum, überlappen sich nie kreuzweise) immer
// exakt das "äußere" Mark an dieser Stelle, unabhängig vom Schema-Rang. Für den
// Korpus-Fall "**fett und *verschachtelt kursiv* darin**" (bold Rang 0 < italic Rang 1
// in diesem Schema) liefert das zusätzlich dieselbe Reihenfolge wie der Quelltext —
// das ist aber kein Zufall, den der Algorithmus VORAUSSETZT: er bestimmt die Deckung
// aus der tatsächlichen Lauflänge, nicht aus dem Rang.

interface Leaf {
  readonly isText: boolean
  readonly text: string
  readonly atom?: MdNode
  readonly marks: readonly Mark[]
}

function toLeaves(parent: PmNode): Leaf[] {
  const leaves: Leaf[] = []
  parent.forEach((child) => {
    if (child.isText) {
      leaves.push({ isText: true, text: child.text ?? '', marks: child.marks })
    } else {
      leaves.push({ isText: false, text: '', atom: convertAtomInline(child), marks: child.marks })
    }
  })
  return leaves
}

function convertAtomInline(node: PmNode): MdNode {
  const handler = atomInlineHandlers[node.type.name]
  if (!handler) {
    throw new Error(`to-markdown: kein Inline-Handler für Node-Typ "${node.type.name}"`)
  }
  return handler(node)
}

const atomInlineHandlers: Record<string, (node: PmNode) => MdNode> = {
  hardBreak: () => ({ type: 'break' }),
  // data.alias ist bei from-markdown IMMER gesetzt (fällt auf den Zielwert zurück,
  // s. convertWikiLink-Kommentar dort) — dieselbe Rückfall-Regel hier, damit
  // stringifyMarkdown (mdast-util-wiki-link: bare Form nur, wenn value === data.alias)
  // ohne Alias wieder die bare `[[ziel]]`-Form erzeugt statt fälschlich `[[ziel|ziel]]`.
  wikiLink: (node) => {
    const target = node.attrs.target as string
    const alias = (node.attrs.alias as string | null) ?? target
    return { type: 'wikiLink', value: target, data: { alias } }
  },
  // stringifyMarkdown writes the label as given (associationId prefers it), so `[^A]`
  // survives; the identifier is derived for editor-created references without one.
  footnoteReference: (node) => {
    const label = node.attrs.label as string
    const identifier = (node.attrs.identifier as string | null) ?? footnoteIdentifier(label)
    return { type: 'footnoteReference', identifier, label }
  },
}

function hasMark(leaf: Leaf, mark: Mark): boolean {
  return mark.isInSet(leaf.marks)
}

function extentOf(leaves: readonly Leaf[], start: number, mark: Mark): number {
  let j = start
  while (j < leaves.length && hasMark(leaves[j]!, mark)) j++
  return j - start
}

function peelOutermostMark(leaves: readonly Leaf[], start: number): Mark {
  const candidates = leaves[start]!.marks
  let best = candidates[0]!
  let bestExtent = extentOf(leaves, start, best)
  for (const candidate of candidates.slice(1)) {
    const extent = extentOf(leaves, start, candidate)
    if (extent > bestExtent) {
      best = candidate
      bestExtent = extent
    }
  }
  return best
}

function withoutMark(leaf: Leaf, mark: Mark): Leaf {
  return { ...leaf, marks: mark.removeFromSet(leaf.marks) }
}

/** Baut aus dem Mark-Set eines Laufs den umschließenden mdast-Knoten. `code` ist in
 *  mdast ein BLATT mit `value` statt `children` (kein weiteres Verschachteln nötig —
 *  der Code-Mark schliesst in diesem Schema ohnehin alle anderen Marks aus, s.
 *  extensions.ts/@tiptap/extension-code Default `excludes: '_'`). */
function wrapMark(mark: Mark, children: MdNode[]): MdNode {
  switch (mark.type.name) {
    case 'bold':
      return { type: 'strong', children }
    case 'italic':
      return { type: 'emphasis', children }
    case 'strike':
      return { type: 'delete', children }
    case 'code':
      return { type: 'inlineCode', value: children.map((child) => child.value ?? '').join('') }
    case 'link':
      return { type: 'link', url: mark.attrs.href as string, children }
    default:
      throw new Error(`to-markdown: kein Mark-Handler für "${mark.type.name}"`)
  }
}

function convertLeaves(leaves: readonly Leaf[]): MdNode[] {
  const result: MdNode[] = []
  let i = 0
  while (i < leaves.length) {
    const leaf = leaves[i]!

    if (leaf.marks.length === 0) {
      if (!leaf.isText) {
        result.push(leaf.atom!)
        i++
        continue
      }
      // Angrenzende unmarkierte Textknoten zu EINEM mdast-Textknoten zusammenfassen
      // (bewahrt exakte Zeichenfolge, vermeidet unnötige Knotengrenzen).
      let text = leaf.text
      let j = i + 1
      while (j < leaves.length && leaves[j]!.isText && leaves[j]!.marks.length === 0) {
        text += leaves[j]!.text
        j++
      }
      result.push({ type: 'text', value: text })
      i = j
      continue
    }

    const mark = peelOutermostMark(leaves, i)
    const end = i + extentOf(leaves, i, mark)
    const stripped = leaves.slice(i, end).map((l) => withoutMark(l, mark))
    result.push(wrapMark(mark, convertLeaves(stripped)))
    i = end
  }
  return result
}

function convertInline(parent: PmNode): MdNode[] {
  return convertLeaves(toLeaves(parent))
}

// --- Öffentliche API -------------------------------------------------------------------

/** Wandelt ein ProseMirror-Dokument des Editor-Schemas (getEditorSchema()) in
 *  Markdown-Text um — Doc -> mdast -> stringifyMarkdown aus @f451/markdown (KEINE
 *  eigene Stringify-Logik, eine Markdown-Wahrheit). Inverse zu markdownToDoc; siehe
 *  roundtrip.test.ts für den Beweis docToMarkdown(markdownToDoc(md)) === md
 *  (byte-identisch) über den gesamten Golden-Korpus. */
export function docToMarkdown(doc: PmNode): string {
  const tree: MdRootLike = { type: 'root', children: convertBlockChildren(doc) }
  return stringifyMarkdown(tree)
}
