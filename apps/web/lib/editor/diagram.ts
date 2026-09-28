/**
 * Diagramm-Erkennung + Pfad-/Slug-Helfer (Phase 3e Task 3). `diagramKind`
 * entscheidet rein aus dem (seiten-relativen) Bild-`src`, ob ein
 * `image`-Node ein Diagramm ist — Grundlage für die NodeView in
 * `ui-extensions.ts` (Bearbeiten-Button statt einfachem `<img>`).
 *
 * `diagramSlug`/`diagramPath` sind das client-seitige Pendant zur
 * Server-Pfadvalidierung (`apps/api/src/drafts/diagram.ts#assertValidPath`,
 * `DIAGRAM_PATH = /^_media\/[A-Za-z0-9][A-Za-z0-9._-]*$/`) — sie müssen den
 * Server-Filter NICHT byte-identisch nachbilden (der Server slugifiziert
 * selbst nicht, er validiert nur), sondern nur sicherstellen, dass der hier
 * erzeugte Name IMMER innerhalb dieses Zeichenraums bleibt, damit ein vom
 * Editor gewählter Titel nie am 400er der Route scheitert.
 */

export type DiagramKind = 'drawio' | 'excalidraw'

// Absolute URLs (http(s):, protokollrelativ //) und data:-URIs sind niemals
// Diagramme, die dieser Editor bearbeiten kann — dieselbe Prüfung wie
// `ui-extensions.ts#ABSOLUTE_SRC`.
const ABSOLUTE_SRC = /^([a-z][a-z0-9+.-]*:)?\/\//i

/** '.drawio.svg' → 'drawio', '.excalidraw.svg' → 'excalidraw', sonst `null`.
 *  Case-insensitiv; nur seiten-relative `_media`-Pfade zählen (absolute/data:-URLs → null). */
export function diagramKind(src: string | null | undefined): DiagramKind | null {
  if (!src || ABSOLUTE_SRC.test(src) || src.startsWith('data:')) return null
  const lower = src.toLowerCase()
  if (lower.endsWith('.drawio.svg')) return 'drawio'
  if (lower.endsWith('.excalidraw.svg')) return 'excalidraw'
  return null
}

// Transliteration der deutschen Umlaute/scharfem S VOR dem generischen
// Zeichenfilter — ohne sie würde `Übersicht` zu `-bersicht` statt
// `uebersicht` (der Buchstabe ginge ersatzlos verloren statt lesbar zu bleiben).
const TRANSLIT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

/** Titel → Dateiname-Slug (a-z0-9-, Umlaute transliteriert); leer/nur
 *  Sonderzeichen → `null`. OHNE Suffix. */
export function diagramSlug(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLIT[c] ?? c)
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : null
}

/** Baut den seiten-relativen `_media`-Pfad eines Diagramms aus Slug + Art. */
export function diagramPath(slug: string, kind: DiagramKind): string {
  return `_media/${slug}.${kind}.svg`
}
