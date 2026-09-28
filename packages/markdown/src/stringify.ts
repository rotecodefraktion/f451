import { unified } from 'unified'
import remarkStringify from 'remark-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkWikiLink from 'remark-wiki-link'
import { defaultHandlers } from 'mdast-util-to-markdown'
import type { Handle } from 'mdast-util-to-markdown'
import { markdownProcessor } from './parse.js'
import type { MdastRoot } from './types.js'

/** mdast-Zugang für den Editor (Phase 2b, Task 2+): derselbe Prozessor wie parsePage,
 *  aber als roher mdast-Baum statt der aufbereiteten ParsedPage-Sicht — kein zweiter,
 *  abweichend konfigurierter Parser. */
export function parseMarkdownTree(markdown: string): MdastRoot {
  return markdownProcessor.parse(markdown)
}

// --- Kanonische Serialisierung ---------------------------------------------------
//
// Konfiguration ist bewusst festgeschrieben (Plan Phase 2b, globale Constraints):
// Bullet '-', Emphasis '*'/Strong '**' (ein '*' pro Ebene, remark-stringify verdoppelt
// für Strong selbst), Fence ``` (Backtick), Rule '---' (Zeichen '-', Standard-
// Wiederholung 3), keine Setext-Headings (immer '#'-Headings). GFM-Handler (Tabellen,
// Task-Listen, Strikethrough, Autolink-Literale) kommen aus remark-gfm, der
// Frontmatter-Handler aus remark-frontmatter (Sicherheitsnetz, falls doch ein
// yaml-Knoten im Baum steckt — im Normalfall trennt splitFrontmatter das Frontmatter
// VOR dem Parsen ab, siehe frontmatter-split.ts). Der Wikilink-Handler kommt von
// remark-wiki-link (mdast-util-wiki-link), respektiert aliasDivider '|' und wurde
// gegen mdast-util-to-markdown@2 (statt der von remark-wiki-link intern genutzten
// 0.6.5-API) manuell durchgetestet (siehe stringify.test.ts) — er funktioniert trotz
// API-Versionssprungs, weil sein handler nur `context.enter/exit` und eine eigene
// `safe()`-Kopie nutzt, die beide mit dem neuen `state`-Objekt kompatibel sind.
//
// Zwei Fallstricke, die eigene Handler brauchen (s.u.): GFM-Autolink-Literale (nackte
// URLs) und der GFM-Alert-Marker `[!TYP]` als erste Blockquote-Zeile.

// --- Autolink-Literale: nackte URL bleibt nackt -----------------------------------
//
// mdast-util-gfm-autolink-literal produziert für eine nackte URL im Text einen ganz
// normalen 'link'-Knoten (url === einziger Text-Kind-Wert) — es gibt keinen
// eigenen Knotentyp und keine to-markdown-Erweiterung dafür. mdast-util-to-markdowns
// Standard-link-Handler erkennt "Text == URL" selbst und schreibt dafür `<url>`
// (CommonMark-Autolink) — syntaktisch ein anderes Konstrukt als die nackte Literal-
// Form und damit ein Kanonizitätsbruch. Der eigene Handler erkennt denselben Fall und
// gibt den Text unverändert (ohne Klammern/spitze Klammern) aus.

interface LiteralLinkNode {
  type: string
  url?: string
  title?: string | null
  children?: Array<{ type: string; value?: string }>
}

function isAutolinkLiteral(node: LiteralLinkNode): node is LiteralLinkNode & { url: string } {
  if (node.title || typeof node.url !== 'string') return false
  if (!node.children || node.children.length !== 1) return false
  const [child] = node.children
  if (child.type !== 'text' || typeof child.value !== 'string') return false
  // GFM-Autolink-Literale: http(s)-URLs behalten ihren Text 1:1, 'www.'-URLs bekommen
  // beim Parsen ein vorangestelltes 'http://' (siehe mdast-util-gfm-autolink-literal).
  return node.url === child.value || node.url === `http://${child.value}`
}

/** Gibt den URL-Text roh aus — wie der 'text'-Handler, aber mit Konstrukt 'autolink'
 *  aktiv, damit die GFM-eigenen unsafe-Muster für '@'/'.'/':' (die genau dieses Muster
 *  außerhalb von Links escapen sollen, damit es beim erneuten Parsen nicht versehentlich
 *  zu einem Autolink wird) hier NICHT greifen — analog zum spitze-Klammern-Zweig des
 *  Standard-link-Handlers (formatLinkAsAutolink), nur ohne die Klammern selbst. */
const literalAutolinkHandler: Handle = (node, _parent, state, info) => {
  const stack = state.stack
  state.stack = []
  const exit = state.enter('autolink')
  const tracker = state.createTracker(info)
  const value = tracker.move(
    state.containerPhrasing(node, { before: info.before ?? '', after: info.after ?? '', ...tracker.current() }),
  )
  exit()
  state.stack = stack
  return value
}

// mdast-util-to-markdown hängt an manche Handler eine `.peek`-Funktion (Vorschau des
// ersten Ausgabezeichens, für Escaping-Entscheidungen im umgebenden Text) — im Handle-
// Typ selbst nicht deklariert, an defaultHandlers.link aber zur Laufzeit vorhanden.
type HandleWithPeek = Handle & { peek?: Handle }

const defaultLinkPeek = (defaultHandlers.link as HandleWithPeek).peek

const linkHandler: HandleWithPeek = (node, parent, state, info) => {
  if (isAutolinkLiteral(node as LiteralLinkNode)) {
    return literalAutolinkHandler(node, parent, state, info)
  }
  return defaultHandlers.link(node, parent, state, info)
}
linkHandler.peek = (node, parent, state, info) =>
  isAutolinkLiteral(node as LiteralLinkNode)
    ? ((node as LiteralLinkNode).children?.[0]?.value?.charAt(0) ?? '')
    : (defaultLinkPeek?.(node, parent, state, info) ?? '[')

// --- Blockquote-Alerts: `[!TYP]`-Marker bleibt unescaped --------------------------
//
// mdast-util-to-markdown escaped jede eckige Klammer am Zeilenanfang generell
// (`atBreak`-Regel in unsafe.js) — Schutz davor, dass Text wie "[label]" versehentlich
// zu einer Link-Referenzdefinition wird, wenn an anderer Stelle im Dokument ein
// passendes "[label]: url" auftaucht. Für unsere fünf bekannten Alert-Marker ist das
// nicht gewollt: der Marker muss unverändert in der ersten Zeile des Blockquotes
// stehen (alerts.ts erkennt ihn genau an diesem Muster). Der Handler delegiert an den
// Standard-blockquote-Handler und entfernt danach gezielt nur das Escaping vor einem
// der fünf bekannten Marker in der ersten Zeile — jedes andere "[...]" am Zeilenanfang
// bleibt escaped (Standardverhalten, sicherheitsrelevant).
const ALERT_MARKER_ESCAPE = /^(>\s?)\\(\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])/

const blockquoteHandler: Handle = (node, parent, state, info) => {
  const value = defaultHandlers.blockquote(node, parent, state, info)
  return value.replace(ALERT_MARKER_ESCAPE, '$1$2')
}

const stringifyProcessor = unified()
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fence: '`',
    rule: '-',
    ruleRepetition: 3,
    setext: false,
    handlers: { link: linkHandler, blockquote: blockquoteHandler },
  })
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkWikiLink, { aliasDivider: '|' })

/** Serialisiert einen mdast-Baum kanonisch zu Markdown-Text (siehe Konfigurations-
 *  Kommentar oben). Kanonizitäts-Gesetz (getestet über den gesamten Golden-Korpus):
 *  stringifyMarkdown(parseMarkdownTree(md)) === md, byte-identisch. */
export function stringifyMarkdown(tree: MdastRoot): string {
  // Cast nötig: unser öffentlicher MdastRoot-Typ ist bewusst minimal (siehe types.ts),
  // mdast-util-to-markdown erwartet den vollen mdast-Nodes-Union-Typ (@types/mdast) —
  // das Paket vermeidet diese Dependency bewusst (analog zu parse.ts/render.ts).
  return String(stringifyProcessor.stringify(tree as never))
}
