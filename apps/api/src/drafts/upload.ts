import { posix } from 'node:path'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { draftBranchName } from './branch-name.js'
import { sanitizeSvg } from './svg-sanitize.js'

export { InvalidSvgError } from './svg-sanitize.js'

/**
 * Media-Upload in den Draft (Plan Task 5): validiert (Extension-Whitelist,
 * Magic-Bytes für Raster, Größenlimit, SVG-Sanitizing), slugifiziert den
 * Dateinamen (Kollision → `-1`/`-2`-Suffix) und committet nach
 * `<Seitenordner>/_media/<Name>` auf den Draft-Branch — mit dem vom Aufrufer
 * übergebenen (Nutzer-)Provider, siehe `routes/drafts.ts`.
 */

export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Plan Global Constraints: Default 10 MiB, überschreibbar über `F451_MAX_UPLOAD_MB`
 *  (gelesen in `server.ts`, siehe Konvention dort — `buildApp`/dieses Modul
 *  bekommen den bereits aufgelösten Wert injiziert, kein `process.env` hier). */
export const DEFAULT_MAX_UPLOAD_MB = 10

export function maxUploadBytes(maxUploadMb: number = DEFAULT_MAX_UPLOAD_MB): number {
  return maxUploadMb * 1024 * 1024
}

/** Whitelist (Plan Task 5, Global Constraints). */
const EXTENSION_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** Whitelist für Nicht-Bild-Anhänge (Editor-Erweiterung „Datei-Anhänge"): PDF,
 *  die drei OpenXML-Office-Formate, ZIP, sowie die reinen Textformate txt/csv/md.
 *  Läuft PARALLEL zu `EXTENSION_WHITELIST` (Bilder) — beide zusammen bilden die
 *  vollständige Menge erlaubter Datei-Endungen für den Media-Upload. */
const DOCUMENT_EXTENSION_WHITELIST = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'zip', 'txt', 'csv', 'md'])

type RasterKind = 'png' | 'jpeg' | 'gif' | 'webp'

/** Magic-Bytes-Kategorie eines Dokument-Anhangs: `pdf` (`%PDF-`-Signatur), `zip`
 *  (die drei Office-Formate SIND ZIP-Container, teilen sich also dieselbe
 *  `PK\x03\x04`-Signatur mit `.zip` selbst) oder `text` (txt/csv/md — reine
 *  Textformate ohne Magic-Bytes-Konzept, hier bewusst OHNE Signaturprüfung,
 *  analog zu SVG bei den Rasterformaten). */
type DocumentKind = 'pdf' | 'zip' | 'text'

const EXTENSION_TO_DOCUMENT_KIND: Partial<Record<string, DocumentKind>> = {
  pdf: 'pdf',
  docx: 'zip',
  xlsx: 'zip',
  pptx: 'zip',
  zip: 'zip',
  txt: 'text',
  csv: 'text',
  md: 'text',
}

/** Prüft die Magic-Bytes eines Dokument-Anhangs, wo robust möglich (PDF/ZIP-
 *  Container) — analog zu `detectRasterKind` für Bilder. `text` hat keine
 *  Signatur und gilt immer als plausibel (Größenlimit greift weiterhin). */
function documentSignatureMatches(kind: DocumentKind, buf: Buffer): boolean {
  if (kind === 'text') return true
  if (kind === 'pdf') {
    return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-'
  }
  // ZIP-Lokaldatei-Header (auch für docx/xlsx/pptx, die ZIP-Container sind).
  return (
    buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  )
}

/** Ordnet jeder Raster-Extension die Magic-Bytes-Kennung zu, die ihr
 *  Inhalt tatsächlich tragen MUSS (`jpg`/`jpeg` teilen sich `jpeg`). */
const EXTENSION_TO_RASTER_KIND: Partial<Record<string, RasterKind>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

/**
 * Magic-Bytes-Erkennung (Plan Task 5: "fake .png mit HTML-Inhalt → 415") —
 * prüft den TATSÄCHLICHEN Dateiinhalt, unabhängig von der behaupteten
 * Extension. Deckt alle vier Rasterformate der Whitelist ab (PNG/JPEG/GIF/
 * WebP); SVG ist Text (kein Magic-Bytes-Konzept) und läuft stattdessen durch
 * `sanitizeSvg`.
 */
function detectRasterKind(buf: Buffer): RasterKind | undefined {
  if (
    buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg'
  }
  if (
    buf.length >= 6
    && buf.subarray(0, 3).toString('ascii') === 'GIF'
    && ['87a', '89a'].includes(buf.subarray(3, 6).toString('ascii'))
  ) {
    return 'gif'
  }
  if (
    buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  return undefined
}

/**
 * Slugifiziert den Dateinamen (Plan Task 5) — dieselbe enge Zeichenmenge wie
 * `branch-name.ts` (`[a-z0-9._-]`), aber ohne Hash-Suffix (Kollisionen werden
 * hier per `-1`/`-2`-Zähler statt Hash gelöst, siehe `resolveUniquePath`).
 *
 * Pfad-Traversal-Schutz: `/` ist kein erlaubtes Zeichen (wird zu `-`), und ein
 * rein aus `.`/`-` bestehendes Präfix/Suffix wird zusätzlich gekappt — aus
 * `"../../etc/passwd"` (Extension bereits vorab abgetrennt) wird dadurch
 * NIEMALS ein Pfadsegment mit `..` (jede Zeichenfolge aus reinen Punkten/
 * Bindestrichen, gleich in welcher Reihenfolge, wird am Rand vollständig
 * entfernt), sondern z. B. `"etc-passwd"`.
 */
function slugifyFilename(filename: string, ext: string): string {
  const base = ext.length > 0 ? filename.slice(0, filename.length - ext.length - 1) : filename
  const lowered = base.toLowerCase()
  let slug = ''
  for (const ch of lowered) {
    slug += /[a-z0-9._-]/.test(ch) ? ch : '-'
  }
  slug = slug.replace(/-{2,}/g, '-').replace(/^[.-]+/, '').replace(/[.-]+$/, '')
  if (slug.length === 0) slug = 'datei'
  return `${slug}.${ext}`
}

/** Medienordner-Konvention (Plan Task 5): `<Seitenordner>/_media` (Wurzelseiten,
 *  `dirname === '.'`, ohne führendes Punkt-Segment). Exportiert seit Phase 2d
 *  Task 3 (`drafts/update.ts`): der Media-Verlust-Check beim Draft-Update
 *  (`take-main`/`keep-mine`) braucht dieselbe Ableitung wie der Upload, sonst
 *  liefen beide Stellen Gefahr auseinanderzudriften. */
export function mediaDirFor(pagePath: string): string {
  const dir = posix.dirname(pagePath)
  return dir === '.' ? '_media' : `${dir}/_media`
}

/** true, wenn unter `path` auf `branch` bereits eine Datei liegt. */
async function pathExists(provider: GitProvider, repo: RepoRef, path: string, branch: string): Promise<boolean> {
  try {
    await provider.readFileBinary(repo, path, branch)
    return true
  } catch (err) {
    if (err instanceof NotFoundError) return false
    throw err
  }
}

/** Obergrenze für den Kollisions-Zähler — verhindert eine Endlosschleife
 *  (bzw. eine unbegrenzte Zahl von Provider-Anfragen) im (praktisch nie
 *  erreichten) Fall, dass alle Suffixe bereits vergeben sind. */
const MAX_COLLISION_ATTEMPTS = 500

/**
 * Löst einen Namenskonflikt im Medienordner auf (Plan Task 5: `-1`-Suffix,
 * mehrfach anwendbar für `-1`, `-2`, …): probiert `<name>`, dann
 * `<base>-1.<ext>`, `<base>-2.<ext>`, … bis ein noch nicht belegter Pfad
 * gefunden ist.
 */
async function resolveUniquePath(
  provider: GitProvider,
  repo: RepoRef,
  branch: string,
  mediaDir: string,
  slugName: string,
): Promise<{ fullPath: string; name: string }> {
  // Diagram files keep their compound extension (`flow-1.drawio.svg`, not
  // `flow.drawio-1.svg`), otherwise f451 no longer treats them as diagrams.
  const compound = /\.(drawio|excalidraw)\.svg$/.exec(slugName)
  const dot = compound ? compound.index : slugName.lastIndexOf('.')
  const base = slugName.slice(0, dot)
  const ext = slugName.slice(dot + 1)

  for (let n = 0; n <= MAX_COLLISION_ATTEMPTS; n += 1) {
    const name = n === 0 ? slugName : `${base}-${n}.${ext}`
    const fullPath = `${mediaDir}/${name}`
    // Bewusst sequenziell (kein Promise.all): jeder Versuch hängt vom Ergebnis des vorigen ab.
    if (!(await pathExists(provider, repo, fullPath, branch))) {
      return { fullPath, name }
    }
  }
  throw new Error(`Zu viele Namenskollisionen für "${slugName}" in "${mediaDir}".`)
}

export interface UploadedFile {
  filename: string
  buffer: Buffer
}

/** Antwortform (Plan Task 5 Interface, um `kind` erweitert — Editor-Erweiterung
 *  „Datei-Anhänge"): `kind` unterscheidet, ob der Client den Upload als Bild
 *  (`setImage`) oder als Datei-Link (`![]()` vs. `[]()`-Markdown-Form) einfügen
 *  soll. `markdown` bleibt für Bilder wörtlich wie zuvor; für Dateien trägt es
 *  die Link-Form mit dem ORIGINAL-Dateinamen (nicht dem slugifizierten) als
 *  Linktext. */
export interface UploadMediaResult {
  path: string
  markdown: string
  kind: 'image' | 'file'
}

/**
 * Führt den vollständigen Media-Upload aus: Größenlimit (413) → Extension-
 * Whitelist (415, Bild ODER Dokument) → Magic-Bytes bei Raster/PDF/ZIP-
 * Containern ODER Sanitizing bei SVG (415/422) → Slugifizieren +
 * Kollisionsauflösung → Commit nach `<Seitenordner>/_media/<Name>` auf den
 * Draft-Branch (Nutzer-Token, `provider` kommt vom Aufrufer bereits
 * nutzergebunden). Antwort wie im Plan-Interface, um `kind` erweitert: Bilder
 * `{ path: '_media/<name>', markdown: '![](_media/<name>)', kind: 'image' }`,
 * Dokumente `{ path: '_media/<name>', markdown: '[<originalname>](_media/<name>)',
 * kind: 'file' }` (relativ zur Seite, NICHT der volle Repo-Pfad, der
 * `<Seitenordner>/` als Präfix trägt — das entspricht der Konvention
 * bestehender Bild-Referenzen, siehe `indexer/index-space.ts`).
 */
export async function uploadMedia(
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
  pagePath: string,
  file: UploadedFile,
  maxBytes: number,
): Promise<UploadMediaResult> {
  if (file.buffer.length > maxBytes) {
    throw new PayloadTooLargeError(
      `Datei ist größer als das erlaubte Limit von ${maxBytes} Bytes (tatsächlich ${file.buffer.length} Bytes).`,
    )
  }

  const ext = extensionOf(file.filename)
  const isImage = EXTENSION_WHITELIST.has(ext)
  const isDocument = DOCUMENT_EXTENSION_WHITELIST.has(ext)
  if (!isImage && !isDocument) {
    const allowed = [...EXTENSION_WHITELIST, ...DOCUMENT_EXTENSION_WHITELIST].sort()
    throw new UnsupportedMediaTypeError(
      `Dateityp "${ext || '(ohne Extension)'}" ist nicht erlaubt (erlaubt: ${allowed.join(', ')}).`,
    )
  }

  let content: string | Buffer
  const kind: 'image' | 'file' = isImage ? 'image' : 'file'
  if (isImage) {
    if (ext === 'svg') {
      // Wirft InvalidSvgError (422) bei leerem/ungültigem Ergebnis — vom
      // Aufrufer (Route) unverändert durchgereicht.
      content = sanitizeSvg(file.buffer.toString('utf8'))
    } else {
      const expectedKind = EXTENSION_TO_RASTER_KIND[ext]
      const actualKind = detectRasterKind(file.buffer)
      if (!actualKind || actualKind !== expectedKind) {
        throw new UnsupportedMediaTypeError(
          `Datei-Inhalt entspricht nicht der Extension ".${ext}" (Magic-Bytes-Prüfung fehlgeschlagen).`,
        )
      }
      content = file.buffer
    }
  } else {
    const documentKind = EXTENSION_TO_DOCUMENT_KIND[ext]!
    if (!documentSignatureMatches(documentKind, file.buffer)) {
      throw new UnsupportedMediaTypeError(
        `Datei-Inhalt entspricht nicht der Extension ".${ext}" (Magic-Bytes-Prüfung fehlgeschlagen).`,
      )
    }
    content = file.buffer
  }

  const branch = draftBranchName(pageId)
  // Dieselbe Konvention wie `routes/media.ts` (Auslieferung): Wurzelseiten
  // bekommen `_media/…` ohne führendes Punkt-Segment.
  const mediaDir = mediaDirFor(pagePath)
  const slugName = slugifyFilename(file.filename, ext)
  const { fullPath, name } = await resolveUniquePath(provider, repo, branch, mediaDir, slugName)

  const message = `docs: Medium "${name}" hochgeladen`
  if (typeof content === 'string') {
    await provider.writeFile(repo, fullPath, content, { branch, message })
  } else {
    await provider.writeFileBinary(repo, fullPath, content, { branch, message })
  }

  const responsePath = `_media/${name}`
  const markdown = kind === 'image' ? `![](${responsePath})` : `[${file.filename}](${responsePath})`
  return { path: responsePath, markdown, kind }
}
