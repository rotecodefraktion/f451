import { matchAlertBlockquote, matchYoutubeParagraph, parseImageAltSize, parseMarkdownTree } from '@f451/markdown'
import type { Mark, Node as PmNode, Schema } from 'prosemirror-model'
import { getEditorSchema } from './index.js'

// --- markdown -> ProseMirror (Task 3, Phase 2b) -------------------------------------
//
// markdownToDoc(body) konsumiert den EINEN geteilten mdast-Baum aus @f451/markdown
// (parseMarkdownTree — remark-parse + frontmatter + gfm + wiki-link, siehe
// packages/markdown/src/parse.ts) und baut daraus rein über prosemirror-model
// (schema.node/schema.text/schema.mark) ein PM-Dokument auf — kein DOM, kein
// HTML-Zwischenschritt, kein jsdom (Tests laufen in Node-vitest). `body` bezeichnet den
// Markdown-Text NACH Frontmatter-Trennung (splitFrontmatter aus @f451/markdown) — ein
// führender yaml-Knoten ist hier nicht vorgesehen (Vertrag von parsePage/render.ts).
//
// Architektur: zwei kleine Handler-Maps (Block-Ebene, Inline-Ebene) statt einer
// Riesen-switch-Kaskade — jeder mdast-Knotentyp hat genau eine Zeile Dispatch plus eine
// eigene, kleine Konvertierungsfunktion. Beide Dispatcher prüfen VOR dem Lookup auf die
// fünf bekannten nicht abbildbaren Knotentypen (assertSupported) und werfen dort hart
// (UnsupportedMarkdownError) — die Fehlerprüfung läuft also in derselben Traversierung,
// die auch den Baum aufbaut (kein zweiter Durchlauf nötig). collectUnsupported (unten)
// ist eine SEPARATE, nicht werfende Traversierung für Aufrufer, die (wie Task 5) eine
// vollständige Befundliste statt eines Hard-Throws beim ersten Fund brauchen.

// --- Lokale, minimale mdast-Node-Typen ----------------------------------------------
//
// Analog zu den lokalen Typen in packages/markdown/src/parse.ts/render.ts: keine
// @types/mdast-Dependency, nur die Felder, die dieser Konverter tatsächlich liest.
// Ein einziges, großzügiges Interface für alle vorkommenden mdast-Knotentypen (Block
// UND Inline) ist hier bewusst einfacher als eine diskriminierte Union — die Felder sind
// optional und pro Knotentyp eindeutig, eine Union würde nur Type-Guards ohne echten
// Mehrwert erzwingen (keine der Handler-Funktionen liest ein Feld, das ihr Knotentyp
// nicht hat).
interface MdNode {
  type: string
  value?: string
  url?: string
  title?: string | null
  alt?: string | null
  lang?: string | null
  depth?: 1 | 2 | 3 | 4 | 5 | 6
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
  align?: ReadonlyArray<'left' | 'center' | 'right' | null>
  data?: { alias?: string }
  children?: MdNode[]
  position?: { start?: { line?: number } }
}

interface MdRootLike {
  type: 'root'
  children: unknown[]
}

// --- Fehlerbild: nicht abbildbare mdast-Knoten --------------------------------------

/** Wird geworfen, wenn markdownToDoc auf einen mdast-Knotentyp trifft, der sich nicht
 *  auf das Editor-Schema abbilden lässt (rohes HTML, Fußnoten, Referenz-Definitionen/
 *  -Bilder/-Links). Trägt den Knotentyp und — sofern die mdast-Position vorhanden ist —
 *  die Zeile, damit der Aufrufer (Task 5) dem Nutzer eine konkrete Fundstelle zeigen
 *  kann. Wird IMMER geworfen, nie still verschluckt. */
export class UnsupportedMarkdownError extends Error {
  readonly nodeType: string
  readonly line: number | undefined

  constructor(nodeType: string, line: number | undefined) {
    super(
      `Nicht unterstützter Markdown-Knoten "${nodeType}"${
        line !== undefined ? ` (Zeile ${line})` : ''
      } — kann nicht auf das Editor-Schema abgebildet werden.`,
    )
    this.name = 'UnsupportedMarkdownError'
    this.nodeType = nodeType
    this.line = line
  }
}

/** Ein Befund für die Sammel-Variante (collectUnsupported). */
export interface UnsupportedFinding {
  type: string
  line: number | undefined
}

const UNSUPPORTED_TYPES = new Set([
  'html',
  'footnoteDefinition',
  'footnoteReference',
  'definition',
  'imageReference',
  'linkReference',
])

function assertSupported(node: MdNode): void {
  if (UNSUPPORTED_TYPES.has(node.type)) {
    throw new UnsupportedMarkdownError(node.type, node.position?.start?.line)
  }
}

/** Nicht werfende Sammel-Variante: durchläuft den GESAMTEN Baum (nicht nur bis zum
 *  ersten Fund) und liefert JEDEN nicht abbildbaren Knoten als {type, line}. Für Task 5
 *  gedacht, die eine vollständige Befundliste braucht statt eines Hard-Throws beim
 *  ersten Treffer — markdownToDoc selbst nutzt diese Funktion NICHT (sie wirft beim
 *  ersten Fund während des eigentlichen Konvertierungsdurchlaufs, siehe oben), sie ist
 *  separat aufrufbar für genau diesen Report-Anwendungsfall. */
export function collectUnsupported(tree: MdRootLike): UnsupportedFinding[] {
  const findings: UnsupportedFinding[] = []
  const walk = (node: MdNode): void => {
    if (UNSUPPORTED_TYPES.has(node.type)) {
      findings.push({ type: node.type, line: node.position?.start?.line })
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const child of tree.children as MdNode[]) walk(child)
  return findings
}

// --- Block-Ebene ---------------------------------------------------------------------

// Handler geben ein ARRAY zurück statt eines einzelnen Nodes: die meisten mdast-
// Blockknoten werden 1:1 auf genau einen PM-Block abgebildet, aber ein mdast-'paragraph'
// kann mehrere PM-Blöcke erzeugen (siehe convertParagraph unten — Bilder sind in diesem
// Schema group: 'block', nicht 'inline', @tiptap/extension-image mit inline: false;
// ein Absatz, der ein Bild enthält, muss das Bild daher als eigenständigen
// Geschwister-Block ausgeben statt es in paragraph.content zu verschachteln, sonst
// verletzt es paragraphs content-Ausdruck 'inline*').
type BlockHandler = (node: MdNode, schema: Schema) => PmNode[]

function convertBlock(node: MdNode, schema: Schema): PmNode[] {
  assertSupported(node)
  const handler = blockHandlers[node.type]
  if (!handler) {
    // Sollte für den unterstützten Dialekt nie eintreten (Golden-Korpus deckt alle
    // Block-Konstrukte ab) — defensiv statt eines stillen Drops.
    throw new Error(`from-markdown: kein Block-Handler für Knotentyp "${node.type}"`)
  }
  return handler(node, schema)
}

function convertBlockChildren(children: MdNode[] | undefined, schema: Schema): PmNode[] {
  return (children ?? []).flatMap((child) => convertBlock(child, schema))
}

/** Body-Content darf laut Schema nie leer sein (Alert `block+`, ListItem
 *  `paragraph block*` faktisch auch nie leer im Korpus) — ein leerer Absatz ist der
 *  neutrale Lückenfüller, falls ein Konstrukt (z. B. Marker-only-Alert ohne Restkörper)
 *  keinen Inhalt mehr übrig lässt. */
function nonEmptyBlockContent(content: PmNode[], schema: Schema): PmNode[] {
  return content.length > 0 ? content : [schema.node('paragraph')]
}

/** Ein mdast-'paragraph' wird normalerweise 1:1 zu einem PM-'paragraph'. Enthält er aber
 *  ein 'image'-Kind, muss dieses als eigener Block-Geschwisterknoten ausgegeben werden
 *  (Bilder sind in diesem Schema group: 'block', siehe Kommentar bei BlockHandler) —
 *  der umgebende Fließtext wird in einen (oder mehrere) separate paragraph-Knoten
 *  aufgeteilt. Deckt den Korpus-Fall "Bild allein in eigenem Absatz" (einziges Kind =
 *  image) ebenso ab wie gemischten Text mit eingestreuten Bildern. Bekannte, bewusst
 *  nicht abgedeckte Lücke: ein Bild INNERHALB von emphasis/strong/link/heading/
 *  Tabellenzelle (verschachtelt tiefer als die unmittelbare paragraph-Ebene) bleibt
 *  unangetastet und würde am eigentlichen Inline-Dispatcher scheitern — kein Fall im
 *  Golden-Korpus, siehe Report.
 *
 *  VOR dieser Bild-Split-Logik: matchYoutubeParagraph (Spec §6, geteilte Erkennung aus
 *  @f451/markdown, Muster matchAlertBlockquote) erkennt eine YouTube-URL allein auf
 *  einer Zeile (Paragraph mit genau einem Autolink-Literal-Kind) und bildet sie auf den
 *  atomaren youtubeEmbed-Node ab — trägt die ORIGINAL-URL als Attribut, nicht nur die
 *  Video-ID, damit die Inverse (to-markdown.ts) die Quellform (youtu.be-Kurzform,
 *  &t=-Parameter) byte-identisch zurückschreiben kann. */
function convertParagraph(node: MdNode, schema: Schema): PmNode[] {
  const youtube = matchYoutubeParagraph(node as never)
  if (youtube) return [schema.node('youtubeEmbed', { url: youtube.url })]

  const children = node.children ?? []
  const blocks: PmNode[] = []
  let run: MdNode[] = []

  const flushRun = (): void => {
    if (run.length === 0) return
    blocks.push(schema.node('paragraph', null, convertInlineChildren(run, schema)))
    run = []
  }

  for (const child of children) {
    if (child.type === 'image') {
      flushRun()
      blocks.push(...inlineHandlers.image!(child, schema, []))
      continue
    }
    run.push(child)
  }
  flushRun()

  return blocks.length > 0 ? blocks : [schema.node('paragraph')]
}

function convertBlockquote(node: MdNode, schema: Schema): PmNode[] {
  const matched = matchAlertBlockquote(node)
  if (matched) {
    const content = convertBlockChildren(matched.bodyChildren as MdNode[], schema)
    // markerOwnParagraph konserviert die Quellform (Marker als eigener Absatz mit
    // Leerzeile vs. Marker + Text im selben Absatz) — to-markdown.ts liest das Attr
    // beim Rückbau, damit der Roundtrip byte-identisch bleibt (s. nodes/alert.ts).
    return [
      schema.node(
        'alert',
        { alertType: matched.alertType, markerOwnParagraph: matched.markerOwnParagraph },
        nonEmptyBlockContent(content, schema),
      ),
    ]
  }
  // nonEmptyBlockContent (wie im Alert-Zweig oben) — ein leeres Blockquote ('>\n', ein
  // valider Markdown-Input) hat KEINE Kind-Blöcke, 'blockquote' verlangt im Schema aber
  // content: 'block+' (mind. einen Block); ohne den Auffüller würde schema.node hier
  // mit einer leeren Kindliste aufgerufen und wirft (Befund I2, Final-Review).
  return [schema.node('blockquote', null, nonEmptyBlockContent(convertBlockChildren(node.children, schema), schema))]
}

function convertList(node: MdNode, schema: Schema): PmNode[] {
  const items = node.children ?? []
  const isTaskList = items.some((item) => item.checked !== null && item.checked !== undefined)

  if (isTaskList) {
    const content = items.map((item) =>
      schema.node(
        'taskItem',
        { checked: item.checked === true },
        nonEmptyBlockContent(convertBlockChildren(item.children, schema), schema),
      ),
    )
    return [schema.node('taskList', null, content)]
  }

  const content = items.map((item) =>
    schema.node('listItem', null, nonEmptyBlockContent(convertBlockChildren(item.children, schema), schema)),
  )
  if (node.ordered) {
    // ProseMirror-toJSON gibt attrs immer aus, sobald das Schema welche kennt (verifiziert
    // gegen orderedList.spec.attrs) — eine "nur setzen, wenn != Default"-Fallunterscheidung
    // brächte hier keinen Vorteil, daher immer explizit durchreichen.
    return [schema.node('orderedList', { start: node.start ?? 1 }, content)]
  }
  return [schema.node('bulletList', null, content)]
}

function convertTable(node: MdNode, schema: Schema): PmNode[] {
  const align = node.align ?? []
  const rows = node.children ?? []
  const rowNodes = rows.map((row, rowIndex) => {
    const cellType = rowIndex === 0 ? 'tableHeader' : 'tableCell'
    const cells = (row.children ?? []).map((cell, columnIndex) => {
      const cellAlign = align[columnIndex] ?? null
      const content = convertInlineChildren(cell.children, schema)
      return schema.node(cellType, { align: cellAlign }, [schema.node('paragraph', null, content)])
    })
    return schema.node('tableRow', null, cells)
  })
  return [schema.node('table', null, rowNodes)]
}

const blockHandlers: Record<string, BlockHandler> = {
  paragraph: convertParagraph,
  heading: (node, schema) => [
    schema.node('heading', { level: node.depth ?? 1 }, convertInlineChildren(node.children, schema)),
  ],
  blockquote: convertBlockquote,
  list: convertList,
  code: (node, schema) => [
    schema.node('codeBlock', { language: node.lang ?? null }, node.value ? [schema.text(node.value)] : []),
  ],
  thematicBreak: (_node, schema) => [schema.node('horizontalRule')],
  table: convertTable,
}

// --- Inline-Ebene ----------------------------------------------------------------------

type InlineHandler = (node: MdNode, schema: Schema, marks: readonly Mark[]) => PmNode[]

function convertInline(node: MdNode, schema: Schema, marks: readonly Mark[]): PmNode[] {
  assertSupported(node)
  const handler = inlineHandlers[node.type]
  if (!handler) {
    throw new Error(`from-markdown: kein Inline-Handler für Knotentyp "${node.type}"`)
  }
  return handler(node, schema, marks)
}

function convertInlineChildren(
  children: MdNode[] | undefined,
  schema: Schema,
  marks: readonly Mark[] = [],
): PmNode[] {
  return (children ?? []).flatMap((child) => convertInline(child, schema, marks))
}

/** GFM-Autolink-Literal-Kriterium (siehe Task-1-Review-Hinweis, dieselbe Prüfung wie in
 *  packages/markdown/src/stringify.ts#isAutolinkLiteral, hier eigenständig implementiert
 *  — der Plan verlangt nur die Alert-Erkennung als geteilte Hilfsfunktion, nicht diese):
 *  ein mdast-'link'-Knoten ist NICHT am Node-Typ als Autolink-Literal erkennbar (auch
 *  reguläre `[text](url)`-Links sind 'link'), sondern daran, dass sein einziger
 *  Text-Kind-Wert exakt der URL entspricht (oder, bei 'www.'-Form, `http://` + Text). */
function isAutolinkLiteral(node: MdNode): boolean {
  if (node.title || typeof node.url !== 'string') return false
  const children = node.children ?? []
  if (children.length !== 1) return false
  const [child] = children
  if (child.type !== 'text' || typeof child.value !== 'string') return false
  return node.url === child.value || node.url === `http://${child.value}`
}

const convertLink: InlineHandler = (node, schema, marks) => {
  const linkMark = schema.mark('link', { href: node.url ?? '', literal: isAutolinkLiteral(node) })
  return convertInlineChildren(node.children, schema, [...marks, linkMark])
}

/** mdast-wikiLink#data.alias ist laut remark-wiki-link/parse.ts IMMER gesetzt (fällt
 *  auf value/target zurück, wenn kein "|alias" im Dokument steht) — nur wenn alias vom
 *  Zielwert abweicht, war im Quelltext ein expliziter Alias angegeben; sonst bleibt das
 *  PM-Attribut alias auf seinem Default null (kein editierbares Alias-Feld befüllt). */
const convertWikiLink: InlineHandler = (node, schema) => {
  const target = node.value ?? ''
  const alias = node.data?.alias && node.data.alias !== target ? node.data.alias : null
  return [schema.node('wikiLink', { target, alias })]
}

const inlineHandlers: Record<string, InlineHandler> = {
  text: (node, schema, marks) => (node.value ? [schema.text(node.value, marks.length ? [...marks] : undefined)] : []),
  // Harter Zeilenumbruch: sowohl die `\`-Form als auch "zwei Leerzeichen am Zeilenende"
  // erzeugen in mdast identisch einen 'break'-Knoten (micromark normalisiert das schon
  // beim Parsen) — markdownToDoc muss hier also gar nicht zwischen den beiden
  // Quellformen unterscheiden, das Ergebnis ist in beiden Fällen ein hardBreak-Node.
  break: (_node, schema) => [schema.node('hardBreak')],
  emphasis: (node, schema, marks) => convertInlineChildren(node.children, schema, [...marks, schema.mark('italic')]),
  strong: (node, schema, marks) => convertInlineChildren(node.children, schema, [...marks, schema.mark('bold')]),
  delete: (node, schema, marks) => convertInlineChildren(node.children, schema, [...marks, schema.mark('strike')]),
  inlineCode: (node, schema, marks) =>
    node.value ? [schema.text(node.value, [...marks, schema.mark('code')])] : [],
  link: convertLink,
  image: (node, schema) => {
    // Obsidian-Suffix `![Alt|400](url)` / `![Alt|400x300]` in echte width/height-
    // Attribute abspalten (Anzeige + Resize-Griffe); der bereinigte Alt-Text bleibt.
    // parseImageAltSize/formatImageAlt (to-markdown) sind exakte Inverse → der
    // Roundtrip bleibt byte-identisch (Markdown-Wahrheit).
    const size = parseImageAltSize(node.alt)
    return [
      schema.node('image', {
        src: node.url ?? '',
        alt: size ? size.alt : (node.alt ?? null),
        title: node.title ?? null,
        ...(size ? { width: size.width, height: size.height ?? null } : {}),
      }),
    ]
  },
  wikiLink: convertWikiLink,
}

// --- Öffentliche API -------------------------------------------------------------------

/** Wandelt Markdown-Body-Text (Frontmatter bereits abgetrennt, siehe splitFrontmatter in
 *  @f451/markdown) in ein ProseMirror-Dokument des Editor-Schemas (getEditorSchema())
 *  um. Nutzt denselben geteilten remark-Prozessor wie die Lese-Pipeline
 *  (parseMarkdownTree) — der Editor sieht also exakt denselben mdast-Baum. Wirft
 *  UnsupportedMarkdownError beim ersten nicht abbildbaren Knoten (siehe oben);
 *  collectUnsupported liefert bei Bedarf die vollständige Befundliste ohne zu werfen. */
export function markdownToDoc(body: string): PmNode {
  const tree = parseMarkdownTree(body) as unknown as MdRootLike
  const schema = getEditorSchema()
  const content = convertBlockChildren(tree.children as MdNode[], schema)
  return schema.node('doc', null, nonEmptyBlockContent(content, schema))
}
