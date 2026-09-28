import { fromHtml } from 'hast-util-from-html'
import { sanitize as hastSanitize, type Schema } from 'hast-util-sanitize'
import { toHtml } from 'hast-util-to-html'
import type { Nodes } from 'hast'

/**
 * SVG-Sanitizing für den Media-Upload (Plan Task 5): Skripte, Event-Handler
 * (`on*`) und `javascript:`-Hrefs müssen raus; `<metadata>` und draw.io-
 * spezifische Attribute (`content` auf dem `svg`-Root, das das eingebettete
 * `mxfile`-XML trägt) müssen erhalten bleiben, damit hochgeladene Diagramme
 * in draw.io/Excalidraw weiter bearbeitbar sind.
 *
 * `foreignObject` wird seit dem Textumbruch-Fix BEHALTEN (vorher gestrippt):
 * draw.io exportiert jedes Label doppelt — der umbrechende Text steckt als
 * XHTML im `foreignObject`, daneben liegt ein einzeiliger `<text>`-Fallback,
 * den draw.io beim Export selbst mit `…` KÜRZT. Strippen zerstörte also die
 * Label-Information unwiederbringlich (nur der gekürzte Fallback blieb).
 * Sicherheitsargument für das Behalten: (1) die App bettet Diagramme
 * ausschließlich als `<img>` ein — Browser führen in Bild-SVGs niemals
 * Skripte aus, unabhängig von `foreignObject`; (2) Direktaufrufe sichert
 * `routes/media.ts` mit `Content-Security-Policy: sandbox` ab; (3) der
 * XHTML-Inhalt wird hier zusätzlich hart gewhitelistet (nur Label-Markup wie
 * div/span/br — `script`/`iframe`/`object`/… landen in `strip`, `on*`-
 * Attribute verwirft das Schema ohnehin).
 *
 * Eigenlösung statt einer zusätzlichen SVG-Sanitizing-Lib (z. B. DOMPurify):
 * `@f451/markdown` (Phase 1b) nutzt für das HTML-Sanitizing beim Markdown-
 * Rendering bereits `rehype-sanitize`/`hast-util-sanitize` (siehe
 * `packages/markdown/src/render.ts`) — dieselbe, im Monorepo bereits
 * auditierte hast/unified-Familie wird hier direkt (ohne den vollen
 * unified-Prozessor) verwendet: `hast-util-from-html` zum Parsen,
 * `hast-util-sanitize` mit einem EIGENEN, SVG-spezifischen Schema (das
 * Markdown-`defaultSchema` aus 1b enthält keinerlei SVG-Tags — siehe
 * Abwägung im Task-Report) und `hast-util-to-html` zum Serialisieren.
 * Sanitizing ist tag-/attribut-BASIERT (Whitelist, kein Regex auf rohem
 * Text) — das ist strukturell robust gegen Groß-/Kleinschreibungs-,
 * Verschachtelungs- und Entity-Tricks, weil ein echter HTML5-Parser
 * (`parse5` unter der Haube) Tag-/Attributnamen bereits normalisiert und
 * Entity-Referenzen bereits auflöst, BEVOR das Schema geprüft wird (siehe
 * Tests: eine `&#106;avascript:`-Entity-Obfuskation wird schon beim Parsen
 * zu `javascript:` dekodiert, `<FOREIGNOBJECT>`/`<ForeignObject>` wird auf
 * den kanonischen Tag-Namen `foreignObject` normalisiert).
 */

export class InvalidSvgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

// --- < / > in Attributwerten -------------------------------------------------
//
// `hast-util-to-html` zielt auf (SVG-in-)HTML, nicht auf strenges XML (siehe
// eigene Doku: "hast is not XML. [...] Passing SVG might break."): beim
// Serialisieren werden das kaufmaennische Und-Zeichen und das Anfuehrungs-
// zeichen in Attributwerten escaped, die spitzen Klammern aber NICHT. In HTML
// ist das unproblematisch (Attributwerte werden nicht auf spitze Klammern
// geparst), in XML 1.0 ist eine rohe oeffnende spitze Klammer in einem
// Attributwert dagegen ein Wohlgeformtheits-Fehler. Das trifft genau den
// draw.io-`content`-Fall: sein dekodierter Wert IST das eingebettete
// `mxfile`-XML, enthaelt also zwangslaeufig spitze Klammern. Ohne Gegen-
// massnahme wuerde das Sanitizing genau das kaputt machen, was es erhalten
// soll (Datei nach dem Schreiben kein wohlgeformtes XML mehr, draw.io kann
// sie nicht mehr oeffnen). Fix: die spitzen Klammern werden vor dem
// Serialisieren durch zwei reservierte Steuerzeichen ersetzt (Codepunkte 1
// und 2 — als literale Zeichen in wohlgeformtem SVG/XML ohnehin nicht
// zulaessig, siehe `stripControlChars` fuer den Kollisionsschutz) und nach
// der Serialisierung durch die passenden Entities ersetzt. Textknoten sind
// NICHT betroffen — dort escaped `hast-util-to-html` die oeffnende spitze
// Klammer bereits korrekt (verifiziert), nur Attributwerte haben die Luecke.
const LT_PLACEHOLDER = String.fromCharCode(1)
const GT_PLACEHOLDER = String.fromCharCode(2)

/** Entfernt C0-Steuerzeichen (Codepunkte 0-31, außer Tab/LF/CR = 9/10/13) aus
 *  einem Attributwert — in wohlgeformtem SVG/XML als literale Zeichen ohnehin
 *  nicht zulässig. Entfernt als Nebeneffekt auch ein bereits im Rohwert
 *  vorhandenes Platzhalter-Steuerzeichen (Kollisionsschutz für den
 *  Platzhalter-Trick oben, statt sich auf abwesende Angreifer-Eingaben zu
 *  verlassen — ohne dies könnte ein Upload mit genau diesen Steuerzeichen im
 *  Namen die Rückersetzung nach `toHtml` gezielt verwirren). */
function stripControlChars(value: string): string {
  let result = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    const isTabLfCr = code === 9 || code === 10 || code === 13
    if (code > 31 || isTabLfCr) result += ch
  }
  return result
}

function protectAngleBrackets(value: string): string {
  return stripControlChars(value).replaceAll('<', LT_PLACEHOLDER).replaceAll('>', GT_PLACEHOLDER)
}

function restoreAngleBrackets(html: string): string {
  return html.replaceAll(LT_PLACEHOLDER, '&lt;').replaceAll(GT_PLACEHOLDER, '&gt;')
}

function protectAttributeValues(node: Nodes): void {
  if (node.type === 'element') {
    for (const [key, value] of Object.entries(node.properties)) {
      if (typeof value === 'string') {
        node.properties[key] = protectAngleBrackets(value)
      } else if (Array.isArray(value)) {
        node.properties[key] = value.map((item) => (typeof item === 'string' ? protectAngleBrackets(item) : item))
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) protectAttributeValues(child)
  }
}

// --- CSS-Injektionsschutz für style-Attribut/-Element -----------------------
//
// `hast-util-sanitize` kennt keine CSS-Semantik — ein erlaubtes `style`-
// Attribut/-Element wird nur auf Tag-/Attribut-Ebene geprüft, sein TEXT-Inhalt
// nicht. `javascript:`-URLs in CSS (`url(javascript:...)`) werden von keinem
// unterstützten Browser mehr ausgeführt (auch nicht in einem per `<img>`
// geladenen SVG, das ohnehin keine Skripte/externen Ressourcen aus CSS lädt),
// zusätzlich sichert `routes/media.ts` direkten Zugriff bereits mit
// `Content-Security-Policy: sandbox` ab — dennoch als Defense-in-Depth: jedes
// `style`-Attribut/-Element, dessen Wert (nach Entfernen von Whitespace,
// case-insensitiv) `javascript:` enthält, wird komplett verworfen.
const JAVASCRIPT_URL_PATTERN = /javascript\s*:/i

function containsJavascriptUrl(value: string): boolean {
  return JAVASCRIPT_URL_PATTERN.test(value.replace(/[\t\n\r]/g, ''))
}

function stripDangerousStyles(node: Nodes): void {
  if (node.type === 'element') {
    const style = node.properties.style
    if (typeof style === 'string' && containsJavascriptUrl(style)) {
      delete node.properties.style
    }
  }
  if ('children' in node) {
    node.children = node.children.filter((child) => {
      if (
        child.type === 'element'
        && child.tagName === 'style'
        && child.children.some((c) => c.type === 'text' && containsJavascriptUrl(c.value))
      ) {
        return false
      }
      stripDangerousStyles(child)
      return true
    })
  }
}

// --- Schema -------------------------------------------------------------

/** Gängige Präsentationsattribute, die auf (fast) jedem Shape-Element sinnvoll
 *  sind (Farbe/Strich/Sichtbarkeit/Textstil) — als '*'-Eintrag, damit sie
 *  nicht auf jedem Tag einzeln wiederholt werden müssen. */
const PRESENTATION_ATTRIBUTES = [
  'id',
  'className',
  'style',
  'transform',
  'opacity',
  'fill',
  'fillRule',
  'fillOpacity',
  'stroke',
  'strokeWidth',
  'strokeLineCap',
  'strokeLineJoin',
  'strokeDashArray',
  'strokeDashOffset',
  'strokeMiterLimit',
  'strokeOpacity',
  'color',
  'clipPath',
  'clipRule',
  'mask',
  'filter',
  'markerStart',
  'markerMid',
  'markerEnd',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'textAnchor',
  'dominantBaseline',
  'pointerEvents',
  'visibility',
  'display',
  'vectorEffect',
  'cursor',
]

/**
 * SVG-Sanitize-Schema (Plan Task 5): Whitelist aus Struktur-/Shape-/Text-/
 * Gradient-/Pattern-Elementen, die draw.io/Excalidraw-Exporte typischerweise
 * erzeugen, PLUS `foreignObject` mit einem harten XHTML-Label-Subset (s.
 * Kopfkommentar — draw.io-Textumbruch). In `strip` landen `script` und alle
 * Einbettungs-/Formular-Tags, deren Kinder sonst „entpackt" erhalten blieben.
 *
 * `clobber: []` (Default der Markdown-1b-Schemas wäre `['id', ...]` mit
 * `user-content-`-Präfix): DOM-Clobbering ist ein Risiko, wenn sanitisiertes
 * HTML per `innerHTML`/`dangerouslySetInnerHTML` in ein bestehendes Dokument
 * eingehängt wird (genau der Fall bei `packages/markdown` — Inline-HTML in
 * gerendertem Seiteninhalt). Hochgeladene SVGs werden dagegen NIE inline
 * eingebettet, sondern ausschließlich als eigenständige Binärdatei über
 * `GET /media/:pageId/*` ausgeliefert (eigenes Dokument/`<img>`, kein
 * gemeinsames DOM mit der Trägerseite) — das Clobbering-Risiko entfällt,
 * während unveränderte `id`s für `url(#id)`/`xlink:href="#id"`-Referenzen
 * (Gradients, ClipPaths, `<use>`) unverzichtbar sind: mit Präfix würden alle
 * internen Referenzen brechen und Diagramme unsichtbar rendern.
 */
const svgSchema: Schema = {
  // `strip` entfernt Tag SAMT Inhalt (nicht-gelistete Tags würden nur
  // „entpackt", ihr Text bliebe): Skripte + alles, was fremden Inhalt laden
  // oder Eingaben annehmen könnte — relevant, seit foreignObject XHTML trägt.
  strip: ['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'audio', 'video', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base'],
  clobber: [],
  // Phase 3e: Excalidraw bettet die Szene als <!-- payload-… -->-Kommentare in die
  // exportierte SVG ein (encodeSvgMetadata). Kommentare sind inert (kein Skript-
  // Vektor; hast parst sie als comment-Nodes, ein „Ausbruch" via --> erzeugt nur
  // Text/gestrippte Elemente) — ohne Erhalt wäre .excalidraw.svg nach dem ersten
  // Speichern nicht mehr re-editierbar.
  allowComments: true,
  ancestors: {
    stop: ['linearGradient', 'radialGradient'],
  },
  protocols: {
    // NUR 'data' erlaubt (eingebettete Rasterbilder als data:-URI, wie
    // draw.io/Excalidraw sie erzeugen) — bewusst KEIN 'http'/'https': anders
    // als ein Klick auf einen `<a>`-Link lösen `xlink:href`/`href` auf
    // `<image>`/`<use>`/`<textPath>` beim bloßen RENDERN der Grafik einen
    // automatischen Ressourcen-Abruf aus (Tracking-Pixel-Risiko — der
    // Betrachter lädt beim Öffnen des Diagramms unbemerkt eine fremde URL,
    // die IP/Zugriffszeitpunkt preisgibt). Ein `<a>`-Hyperlink-Tag ist daher
    // ebenfalls NICHT im Schema (Diagramme brauchen ihn praktisch nie, siehe
    // Task-Report) — das vermeidet, dass dieselbe Protokoll-Zulassung für
    // "Klick" (unkritisch) und "automatischer Ladevorgang" (kritisch)
    // gleichzeitig gelten müsste. Kein Eintrag für 'javascript' o.ä. — nur
    // explizit gelistete Protokolle werden akzeptiert (Deny-by-default), alles
    // andere (inkl. `javascript:` in jeder Groß-/Kleinschreibung, da der
    // Vergleich fallsensitiv gegen die erlaubte Liste läuft und `javascript`
    // dort nie auftaucht) wird verworfen. Reine Fragment-Referenzen (`#id`,
    // kein ':' vor dem ersten '#'/'?'/'/') sind gemäß `hast-util-sanitize`
    // immer erlaubt (lokale Referenzen, z. B. `<use xlink:href="#g1">`).
    href: ['data'],
    xLinkHref: ['data'],
  },
  tagNames: [
    'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'title', 'desc', 'metadata', 'style',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textPath', 'image',
    'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
    // draw.io-Textumbruch (s. Kopfkommentar): foreignObject + das XHTML-
    // Label-Subset, das draw.io/Excalidraw-Labels tatsächlich erzeugen.
    'foreignObject', 'div', 'span', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'font', 'ul', 'ol', 'li', 'sub', 'sup',
  ],
  attributes: {
    '*': PRESENTATION_ATTRIBUTES,
    svg: ['xmlns', 'xmlnsXLink', 'version', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'content'],
    image: ['xLinkHref', 'href', 'x', 'y', 'width', 'height', 'preserveAspectRatio'],
    use: ['xLinkHref', 'href', 'x', 'y', 'width', 'height'],
    path: ['d'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    line: ['x1', 'y1', 'x2', 'y2'],
    polyline: ['points'],
    polygon: ['points'],
    text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
    tspan: ['x', 'y', 'dx', 'dy', 'rotate'],
    textPath: ['xLinkHref', 'startOffset'],
    symbol: ['id', 'viewBox', 'preserveAspectRatio'],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
    stop: ['offset', 'stopColor', 'stopOpacity'],
    pattern: ['id', 'patternUnits', 'patternContentUnits', 'patternTransform', 'viewBox', 'x', 'y', 'width', 'height'],
    clipPath: ['id', 'clipPathUnits'],
    mask: ['id', 'maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height'],
    marker: ['id', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'viewBox'],
    // `requiredFeatures` steuert die <switch>-Wahl (draw.io setzt es auf dem
    // foreignObject); `xmlns` auf dem Wrapper-div ist PFLICHT — die Datei wird
    // als image/svg+xml (XML) geparst, ohne den XHTML-Namespace würde der
    // Label-Inhalt nicht als HTML gerendert (Labels wären unsichtbar).
    foreignObject: ['x', 'y', 'width', 'height', 'requiredFeatures'],
    div: ['xmlns'],
    font: ['color', 'face', 'size'],
  },
}

/** true, wenn der Baum (rekursiv) irgendein Element oder nicht-leeren
 *  Textknoten enthält — Grundlage für die "leer nach dem Sanitizing"-Prüfung. */
function hasMeaningfulContent(node: Nodes): boolean {
  if (node.type === 'element') return true
  if (node.type === 'text') return node.value.trim().length > 0
  if ('children' in node) return node.children.some((child) => hasMeaningfulContent(child))
  return false
}

/**
 * Sanitisiert ein hochgeladenes SVG (Plan Task 5): parst es als HTML-
 * eingebettetes SVG-Fragment, entfernt Skripte/Event-Handler/`javascript:`-
 * Hrefs/`foreignObject` per Whitelist-Schema, behält `content`
 * (draw.io-`mxfile`) und `<metadata>` bei. Wirft `InvalidSvgError`, wenn kein
 * `<svg>`-Root gefunden wird ODER der bereinigte Baum darunter keinen
 * sichtbaren Inhalt mehr hat (z. B. eine Datei, die nur aus einem
 * `<script>`-Tag bestand) — der Aufrufer mappt das auf 422.
 */
export function sanitizeSvg(raw: string): string {
  const tree = fromHtml(raw, { fragment: true, space: 'svg' })
  const svgRoot = tree.children.find((node) => node.type === 'element' && node.tagName === 'svg')
  if (!svgRoot || svgRoot.type !== 'element') {
    throw new InvalidSvgError('Kein gültiges SVG-Root-Element gefunden.')
  }

  const clean = hastSanitize(svgRoot, svgSchema)
  // NICHT `hasMeaningfulContent(clean)` direkt: `clean` ist (bei einem
  // whitelisteten Root-Tag) selbst immer ein Element und würde damit trivial
  // IMMER `true` liefern (die Funktion kennt "ist ein Element" bereits als
  // hinreichend) — die eigentliche Frage ist, ob darunter noch etwas übrig
  // ist, daher die Prüfung auf `clean.children`.
  if (clean.type !== 'element' || !clean.children.some((child) => hasMeaningfulContent(child))) {
    throw new InvalidSvgError('SVG ist nach dem Sanitizing leer (kein verbleibender Inhalt).')
  }

  stripDangerousStyles(clean)
  protectAttributeValues(clean)
  // XML-Wohlgeformtheit der HTML-Void-Elemente im foreignObject (praktisch:
  // <br>) ist durch `space: 'svg'` bereits gegeben — to-html schließt im
  // SVG-Space JEDES Element explizit (`<br></br>`, per Test verifiziert), ein
  // offenes `<br>` (Wohlgeformtheits-Fehler in image/svg+xml) entsteht nicht.
  return restoreAngleBrackets(toHtml(clean, { space: 'svg' }))
}
