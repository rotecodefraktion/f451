import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { draftBranchName } from './branch-name.js'
import { sanitizeSvg } from './svg-sanitize.js'
import { mediaDirFor, PayloadTooLargeError, UnsupportedMediaTypeError } from './upload.js'

export { InvalidSvgError } from './svg-sanitize.js'

/**
 * Diagramm-Speicherung im Draft (Phase 3e Task 2): legt ein Diagramm
 * (`.drawio.svg`/`.excalidraw.svg`) unter `<Seitenordner>/_media/<Name>` auf
 * dem Draft-Branch an ODER überschreibt es in place (im Unterschied zum
 * Media-Upload aus `upload.ts`, der bei Namenskollision einen `-1`/`-2`-
 * Suffix vergibt statt zu überschreiben — der Editor kennt hier den
 * Zielnamen bereits, siehe Plan-Interface). Teilt Sanitizing (`sanitizeSvg`)
 * und Größenlimit-Konvention (`PayloadTooLargeError`) mit dem Media-Upload.
 */

export const DIAGRAM_SUFFIXES = ['.drawio.svg', '.excalidraw.svg'] as const

/** Pfad ungültig (nicht `_media/<name>`, Traversal, Leername) → HTTP 400. */
export class DiagramPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** `ifAbsent` gesetzt, Datei existiert bereits → HTTP 409. */
export class DiagramExistsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export interface SaveDiagramInput {
  path: string
  content: string
  ifAbsent?: boolean
}

export interface SaveDiagramResult {
  path: string
}

// Genau ein Pfadsegment unterhalb von `_media/` (kein `/`, damit auch kein
// `..`-Segment als eigenes Pfadsegment durchrutschen kann), Name beginnt
// alphanumerisch — Traversal ist damit strukturell unmöglich (analog zur
// Slugifizierung in `upload.ts`, dort per Zeichen-Whitelist statt Regex-Anker).
const DIAGRAM_PATH = /^_media\/[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertValidPath(path: string): void {
  if (!DIAGRAM_PATH.test(path)) {
    throw new DiagramPathError(`Ungültiger Diagramm-Pfad: "${path}"`)
  }
  const name = path.slice('_media/'.length)
  const suffix = DIAGRAM_SUFFIXES.find((s) => name.toLowerCase().endsWith(s))
  if (!suffix) {
    throw new UnsupportedMediaTypeError(
      `Diagramm-Suffix nicht erlaubt (erlaubt: ${DIAGRAM_SUFFIXES.join(', ')}).`,
    )
  }
  if (name.length <= suffix.length) {
    throw new DiagramPathError('Diagramm-Name fehlt.')
  }
}

/**
 * Legt ein Diagramm an oder überschreibt es in place auf dem Draft-Branch.
 * `path` ist seiten-relativ (`_media/<name>.drawio.svg`|`.excalidraw.svg`).
 */
export async function saveDiagram(
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
  pagePath: string,
  input: SaveDiagramInput,
  maxBytes: number,
): Promise<SaveDiagramResult> {
  assertValidPath(input.path)

  if (Buffer.byteLength(input.content, 'utf8') > maxBytes) {
    throw new PayloadTooLargeError(`Diagramm ist größer als das erlaubte Limit von ${maxBytes} Bytes.`)
  }

  // Wirft InvalidSvgError (422) bei leerem/ungültigem Ergebnis — vom Aufrufer
  // (Route) unverändert durchgereicht, wie beim Media-Upload.
  const clean = sanitizeSvg(input.content)

  const branch = draftBranchName(pageId)
  const fullPath = `${mediaDirFor(pagePath)}/${input.path.slice('_media/'.length)}`

  // Bestand ermitteln: vorhandener Blob-SHA erlaubt Overwrite-in-place: NUR
  // `NotFoundError` bedeutet "existiert nicht" (Muster `pathExists` in
  // `upload.ts`) — jeder andere Fehler (Provider nicht erreichbar etc.) wird
  // durchgereicht, statt fälschlich als "existiert nicht" gewertet zu werden;
  // sonst würde ein Provider-Ausfall den `ifAbsent`-Schutz aushebeln UND
  // einen Commit ohne den nötigen Konflikt-SHA riskieren.
  let existingSha: string | undefined
  try {
    existingSha = (await provider.readFileBinary(repo, fullPath, branch)).sha
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err
    existingSha = undefined
  }

  if (existingSha !== undefined && input.ifAbsent) {
    throw new DiagramExistsError(`Diagramm existiert bereits: "${input.path}"`)
  }

  const message = existingSha !== undefined
    ? `docs: Diagramm "${input.path}" aktualisiert`
    : `docs: Diagramm "${input.path}" angelegt`
  await provider.writeFile(repo, fullPath, clean, {
    branch,
    message,
    ...(existingSha !== undefined ? { sha: existingSha } : {}),
  })

  return { path: input.path }
}
