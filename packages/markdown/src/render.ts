import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkWikiLink from 'remark-wiki-link'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeMinifyWhitespace from 'rehype-minify-whitespace'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Options as SanitizeSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import { parseImageAltSize } from './image-size.js'
import { createSlugger } from './slug.js'
import { remarkAlerts } from './alerts.js'
import { matchYoutubeParagraph } from './youtube.js'
import { rehypeCodeLang } from './code-lang.js'
import type { ParseOptions } from './types.js'

export interface RenderOptions extends ParseOptions {
  /** Löst ein internes Linkziel auf. null = Ziel existiert nicht (Broken Link). */
  resolveLink(rawTarget: string, kind: 'wikilink' | 'relative'): { href: string } | null
  /** Präfix für relative Bildpfade (z. B. Media-Endpoint der Seite). Default: unverändert. */
  resolveImage?(src: string): string
}

// --- mdast-Transform: Wikilinks/interne Links/Bilder VOR remark-rehype auflösen ---
//
// Läuft als letzter remark-Schritt, bevor der Baum an remark-rehype übergeben wird.
// Lokale, minimale Node-Typen statt einer @types/mdast-Dependency — analog zu parse.ts.

/** Gemeinsame Sicht auf die mdast-Knoten, die dieser Schritt umschreibt (wikiLink,
 *  link, image). Felder sind bewusst optional, weil sich der Knotentyp beim
 *  Umschreiben ändert (z. B. wikiLink -> link -> strong/span). */
interface MutableMdastNode {
  type: string
  value?: string
  url?: string
  alt?: string | null
  children?: unknown[]
  data?: { alias?: string; hName?: string; hProperties?: Record<string, unknown> }
}

/** Extrahiert den sichtbaren Text eines Inline-Knotens rekursiv (wie in parse.ts). */
function textFromNode(node: { type: string; value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value
  if (Array.isArray(node.children)) {
    return node.children.map((child) => textFromNode(child as typeof node)).join('')
  }
  return ''
}

function isExcludedUrl(url: string): boolean {
  return url.includes('://') || url.startsWith('#') || url.startsWith('mailto:')
}

/** Wandelt einen Link-artigen Knoten in ein <span class="broken-link">-Äquivalent um.
 *  Ein mdast-'link'-Knoten würde in mdast-util-to-hast immer ein href aus url erzeugen —
 *  daher wird der Knoten stattdessen als 'strong' getarnt (leere Basis-properties) und
 *  per data.hName/hProperties auf <span> umgebogen, wie im Task-Brief vorgegeben. */
function markBroken(node: MutableMdastNode, text: string): void {
  node.type = 'strong'
  node.children = [{ type: 'text', value: text }]
  node.data = {
    hName: 'span',
    hProperties: { className: 'broken-link', title: `Seite existiert nicht: ${text}` },
  }
  delete node.value
  delete node.url
}

function remarkResolveLinks(opts: RenderOptions) {
  return (tree: any): void => {
    visit(tree, (node: any) => {
      const mutable = node as MutableMdastNode
      const type = mutable.type

      if (type === 'wikiLink') {
        const rawTarget = mutable.value ?? ''
        const text = mutable.data?.alias ?? rawTarget
        const resolved = opts.resolveLink(rawTarget, 'wikilink')
        if (resolved) {
          mutable.type = 'link'
          mutable.url = resolved.href
          mutable.children = [{ type: 'text', value: text }]
          delete mutable.value
          // remark-wiki-link setzt bereits data.hName='a'/hProperties.href (eigener
          // Default-Pageresolver) — das würde unseren href sonst über applyData wieder
          // überschreiben. Der Knoten ist jetzt ein normaler 'link', braucht die
          // Overrides nicht mehr.
          delete mutable.data
        } else {
          markBroken(mutable, text)
        }
        return
      }

      if (type === 'link') {
        const url = mutable.url ?? ''
        if (isExcludedUrl(url)) {
          if (url.includes('://')) {
            mutable.data = {
              ...mutable.data,
              hProperties: { ...mutable.data?.hProperties, rel: 'noopener noreferrer' },
            }
          }
          return
        }
        const resolved = opts.resolveLink(url, 'relative')
        if (resolved) {
          mutable.url = resolved.href
        } else {
          markBroken(mutable, textFromNode(node))
        }
        return
      }

      if (type === 'image') {
        // Obsidian-Stil `![Alt|400](url)` / `![Alt|400x300](url)`: Maße aus dem
        // Alt-Text abspalten und als width/height an das <img> hängen. Läuft vor
        // resolveImage, damit der bereinigte Alt-Text und die relative Pfad-Auflösung
        // gemeinsam greifen.
        const size = parseImageAltSize(mutable.alt)
        if (size) {
          mutable.alt = size.alt
          mutable.data = {
            ...mutable.data,
            hProperties: {
              ...mutable.data?.hProperties,
              width: size.width,
              ...(size.height !== undefined ? { height: size.height } : {}),
            },
          }
        }
        if (opts.resolveImage && typeof mutable.url === 'string') {
          mutable.url = opts.resolveImage(mutable.url)
        }
      }
    })
  }
}

// --- mdast-Transform: YouTube-URL allein auf einer Zeile -> Thumbnail-Embed --------
//
// Spec §6. Läuft nach remarkAlerts. visit(tree, 'paragraph', ...) besucht JEDEN
// Paragraph-Knoten im Baum, unabhängig von der Verschachtelungstiefe — nicht nur
// Top-Level-Paragraphen. Das ist gewollt: „URL allein auf einer Zeile" gilt
// unabhängig vom Kontext, ein Embed in einer Liste, einem Blockquote oder einem
// Alert ist gültiger Flow-Content (Alerts selbst enthalten Absätze, die hier
// ebenfalls zu Embeds werden können — die Reihenfolge zu remarkAlerts ist dabei
// unkritisch, beide Schritte behandeln disjunkte Knotenarten). Wandelt den
// Treffer-Paragraph per
// data.hName/hProperties/hChildren in Thumbnail-Markup um — analog zu remarkAlerts'
// Umbiegen von blockquote -> div, nur dass hChildren hier die mdast-Kinder komplett
// durch fertiges hast-Markup ersetzt (kein Rückgriff auf die restliche Transform-Kette
// nötig, das Innere ist reines Lese-HTML, keine weitere Markdown-Struktur).

/** Lokale, minimale Node-Typen für diesen Schritt — analog zu MutableNode in alerts.ts. */
interface MutableNode {
  type?: string
  children?: unknown[]
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] }
}

type MdRoot = { type: string; children?: unknown[] }

function remarkYoutubeEmbeds() {
  return (tree: MdRoot): void => {
    visit(tree as any, 'paragraph', (node: MutableNode) => {
      const match = matchYoutubeParagraph(node as never)
      if (!match) return
      // Thumbnail-zuerst-Markup OHNE iframe (Entscheidung 1 im Plan): der
      // Link degradiert ohne JS zu einem normalen YouTube-Link; das
      // youtube-nocookie-iframe baut erst der Klick-Handler der Leseansicht.
      node.data = {
        hName: 'div',
        hProperties: { className: ['yt-embed'], dataVideoId: match.videoId },
        hChildren: [
          {
            type: 'element',
            tagName: 'a',
            properties: { className: ['yt-link'], href: match.url, rel: ['nofollow', 'noopener'] },
            children: [
              {
                type: 'element',
                tagName: 'img',
                properties: {
                  className: ['yt-thumb'],
                  src: `https://i.ytimg.com/vi/${match.videoId}/hqdefault.jpg`,
                  alt: 'YouTube-Video-Vorschaubild',
                  loading: 'lazy',
                },
                children: [],
              },
              {
                // Kein Text-Kind: der Beschriftungstext folgt der UI-Sprache
                // (Issue #9), nicht der Seitensprache — er kommt erst clientseitig
                // über eine CSS Custom Property herein (s. `apps/web/app/layout.tsx`,
                // `.yt-play::before { content: var(--label-youtube-play) }` in
                // `apps/web/app/styles/61-lese.css`).
                type: 'element',
                tagName: 'span',
                properties: { className: ['yt-play'] },
                children: [],
              },
            ],
          },
        ],
      }
    })
  }
}

// --- hast-Transform: Heading-IDs über die gemeinsame slugify-Quelle ---------------
//
// Bewusst kein rehype-slug: parsePage (ToC) und renderHtml (HTML-IDs) sollen exakt
// dieselbe Slug-Logik verwenden, daher eigener Schritt mit createSlugger aus src/slug.ts.

function hastText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value
  if (Array.isArray(node.children)) {
    return node.children.map((child) => hastText(child as typeof node)).join('')
  }
  return ''
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

function rehypeHeadingIds() {
  // Frische Slugger-Instanz pro Aufruf dieser Factory-Funktion: unified() ruft sie beim
  // Aufbau der Pipeline in renderHtml genau einmal pro Dokument auf (renderHtml baut den
  // Prozessor bei jedem Aufruf neu auf), daher zählt der Counter korrekt nur innerhalb
  // eines Dokuments und läuft in derselben Heading-Reihenfolge wie parsePage.
  const slugger = createSlugger()
  return (tree: any): void => {
    visit(tree, (node: any) => {
      if (node.type === 'element' && HEADING_TAGS.has(node.tagName)) {
        node.properties = node.properties ?? {}
        node.properties.id = slugger(hastText(node))
      }
    })
  }
}

// --- hast transform: empty footnote label ---------------------------------------------
//
// The visible label text follows the UI language, not the page language: it comes from
// CSS (`::before` with an i18n custom property), like the alert titles. remark-rehype
// cannot emit an empty label itself (`footnoteLabel: ''` falls back to 'Footnotes'),
// hence this step. Matches the section by `dataFootnotes`, never by the label element.

function rehypeEmptyFootnoteLabel() {
  return (tree: any): void => {
    visit(tree, 'element', (node: any) => {
      if (node.tagName !== 'section' || node.properties?.dataFootnotes === undefined) return
      for (const child of node.children ?? []) {
        if (child.type === 'element' && child.tagName === 'p' && child.properties?.id === 'footnote-label') {
          child.children = []
        }
      }
    })
  }
}

// --- Sanitize-Schema: Default (GitHub-Stil) + die von diesem Rendering erzeugten Extras -

type AttributeEntry = string | [string, ...Array<string | number | boolean | RegExp | null | undefined>]

/** `hast-util-sanitize`s `findDefinition` nimmt für einen Property-Namen IMMER nur den
 *  ERSTEN Treffer in der Attributliste (First-Match, kein Merge von Haus aus) — ein
 *  zweites `['className', …]`-Tupel für dieselbe Property würde sonst klanglos
 *  IGNORIERT, nicht etwa zusammengeführt (Fix-Runde 1: genau das war der Bug bei `a`,
 *  wo `defaultSchema.attributes.a` bereits `['className', 'data-footnote-backref']`
 *  trägt — ein angehängtes `['className', 'yt-link']` griff nie, `a.yt-link` blieb
 *  `class=""`). Diese Hilfsfunktion merged daher explizit in ein evtl. vorhandenes
 *  `className`-Tupel hinein, statt ein zweites danebenzustellen — dieselbe Technik wie
 *  in `diff.ts`s `withMergedClassNames` (dortiger Sanitizer-Aufbau für die separaten
 *  Diff-Klassen), hier lokal dupliziert, weil `diff.ts` bereits von `render.ts`
 *  importiert und ein Reimport zurück einen Zyklus erzeugen würde. */
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

// Exportiert (Task 4, Diff-Engine): `diff.ts` klont dieses Basis-Schema und erweitert
// die Kopie NUR für seinen eigenen, separaten Sanitizer-Aufruf um ins/del/Diff-Klassen
// (Wort-Diff, Tabellen-Zellvergleich, Frontmatter-Block) — der Aufbau hier (Clobber-Fix,
// broken-link-Span, Alert-Klassen) bleibt UNVERÄNDERT das normale Seiten-Schema, das
// `renderHtml` unten weiter verwendet. Keine gemeinsame Mutation, kein Diff-Einfluss auf
// normale Seiten.
export const baseSanitizeSchema: SanitizeSchema = (() => {
  const base = structuredClone(defaultSchema)
  // Default-Schema prefixt id/name via clobberPrefix ('user-content-') zum Schutz vor
  // DOM-Clobbering. Heading-IDs müssen aber exakt dem slugify-Ergebnis entsprechen,
  // damit sie mit den ToC-Slugs aus parsePage übereinstimmen.
  // aria-describedby references an id; since ids are no longer prefixed, prefixing the
  // reference would make it point nowhere (GFM footnote refs -> `#footnote-label`).
  base.clobber = (base.clobber ?? []).filter((name) => name !== 'id' && name !== 'ariaDescribedBy')
  const attrs = (base.attributes ?? {}) as Record<string, AttributeEntry[]>
  base.attributes = {
    ...base.attributes,
    // a: defaultSchema hat bereits einen className-Eintrag (Footnote-Backref) ->
    // MERGEN statt anhängen (siehe withMergedClassNames oben).
    a: [...withMergedClassNames(attrs.a, ['yt-link']), 'rel'],
    // span/p/div/img haben in defaultSchema KEINEN vorhandenen className-Eintrag
    // (geprüft gegen hast-util-sanitize@5 defaultSchema) — withMergedClassNames
    // legt dort einfach einen neuen Eintrag an, verhält sich also wie das
    // bisherige direkte Anhängen, ist aber einheitlich mit dem a-Fall.
    span: [...withMergedClassNames(attrs.span, ['broken-link', 'yt-play'])],
    // Alert-Boxen (Task 4): exakte Klassenliste statt /^alert/-Regex (Review-Auflage
    // aus Task 3) — verhindert, dass beliebige "alert*"-Klassen eingeschleust werden.
    // Phase 3d: 'yt-embed' + 'dataVideoId' analog für den YouTube-Thumbnail-Embed.
    div: [
      ...withMergedClassNames(attrs.div, [
        'alert',
        'alert-note',
        'alert-tip',
        'alert-important',
        'alert-warning',
        'alert-caution',
        'yt-embed',
      ]),
      // Der Sanitizer prüft nur, DASS dataVideoId als Attributname erlaubt ist —
      // nicht den WERT. Die Absicherung gegen manipulierte/fremde IDs ist die
      // doppelte Validierung an anderer Stelle: youtubeVideoId() erzeugt die ID
      // serverseitig strikt als [A-Za-z0-9_-]{11} (youtube.ts), und die Leseansicht
      // validiert das data-video-id-Attribut erneut, bevor sie daraus das
      // iframe baut (Plan-Entscheidung 2) — kein roher Attributwert landet
      // ungeprüft in einer src-URL.
      'dataVideoId',
    ],
    // footnotes-title: label of the GFM footnote section (text comes from CSS).
    p: [...withMergedClassNames(attrs.p, ['alert-title', 'footnotes-title'])],
    img: [...withMergedClassNames(attrs.img, ['yt-thumb']), 'loading'],
    // Code header (theming structure 1): rehypeCodeLang sets data-lang on <pre>.
    pre: [...(attrs.pre ?? []), 'dataLang'],
  }
  return base
})()

// --- Prozessor ---------------------------------------------------------------------

/** Rendert Markdown zu sanitisiertem HTML. Frontmatter wird entfernt, Wikilinks und
 *  relative Links über resolveLink aufgelöst (nicht auflösbar -> span.broken-link,
 *  kein href), externe Links bekommen rel="noopener noreferrer", Bilder werden optional
 *  über resolveImage umgeschrieben. Heading-IDs nutzen dieselbe slugify-Quelle wie
 *  parsePage. Inline-HTML (z. B. <b>, <em>, <br>) wird bewusst durch die Pipeline
 *  gelassen (allowDangerousHtml + rehypeRaw) und danach von rehypeSanitize geprüft —
 *  ohne das wäre rohes HTML nicht "entfernt" (sicher), sondern remark-rehype würde es
 *  komplett verschlucken, auch harmlose Tags wie <b>. Wirft nie — ungültiges
 *  Frontmatter erscheint einfach nicht im Output. rehypeRaw parst den gesamten Baum
 *  über parse5 (HTML5-Parsing-Regeln) neu — dabei werden die von remark-rehype
 *  eingefügten Whitespace-Textknoten zwischen table/thead/tbody/tr "foster-parented"
 *  (Text ist dort laut HTML5-Spec ungültig), was sonst dutzende Leerzeilen im Output
 *  erzeugt. rehypeMinifyWhitespace räumt das auf (lässt pre/code unangetastet). */
export function renderHtml(markdown: string, opts: RenderOptions): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm)
    .use(remarkWikiLink, { aliasDivider: '|' })
    .use(remarkResolveLinks, opts)
    .use(remarkAlerts)
    .use(remarkYoutubeEmbeds)
    // Footnote label as a <p>, not an <h2>: no heading id rewrite (refs keep pointing
    // at #footnote-label). Its text is emptied by rehypeEmptyFootnoteLabel below.
    .use(remarkRehype, {
      allowDangerousHtml: true,
      footnoteLabelTagName: 'p',
      footnoteLabelProperties: { className: ['footnotes-title'] },
    })
    .use(rehypeRaw)
    .use(rehypeEmptyFootnoteLabel)
    .use(rehypeMinifyWhitespace)
    .use(rehypeHeadingIds)
    .use(rehypeCodeLang)
    .use(rehypeSanitize, baseSanitizeSchema)
    .use(rehypeStringify)
    .processSync(markdown)

  return String(file)
}
