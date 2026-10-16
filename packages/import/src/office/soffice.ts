// LibreOffice runner, shared by the convert service (apps/convert) and the CLI's
// local mode so both give the same output (spec 2026-10-16-office-import §1, §4).
//
// Each call gets its own work dir under `workRoot` (removed afterwards) with its
// own LibreOffice profile; the profile is written fresh per job with macros
// disabled, so no state carries over between jobs.

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { ODF_EXTENSION, extensionOf, officeKind } from './kinds.js'

export { officeKind } from './kinds.js'

export class ConvertError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ConvertError'
  }
}

export type ExportTarget = 'docx' | 'pdf' | 'pptx' | 'xlsx'
export type ConvertTarget = 'html' | ExportTarget
export const CONVERT_TARGETS: readonly ConvertTarget[] = ['html', 'docx', 'pdf', 'pptx', 'xlsx']

export function isConvertTarget(v: string): v is ConvertTarget {
  return (CONVERT_TARGETS as readonly string[]).includes(v)
}

export type SofficeResult = { zip: Uint8Array } | { file: Uint8Array }

// Macro security "very high" (3), macro execution off, no update check, no
// recovery data. Unknown keys are ignored by LibreOffice.
const PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Jobs/Jobs/org.openoffice.Office.Jobs:Job['UpdateCheck']/Arguments"><prop oor:name="AutoCheckEnabled" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Recovery/AutoSave"><prop oor:name="Enabled" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Recovery/RecoveryInfo"><prop oor:name="Enabled" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`

export async function runSoffice(
  input: { bytes: Uint8Array; name: string },
  to: ConvertTarget,
  opts: { timeoutS: number; workRoot: string },
): Promise<SofficeResult> {
  if (!isConvertTarget(to)) throw new ConvertError(`unknown target "${String(to)}"`, 400)
  if (to === 'html' && !officeKind(input.name)) throw new ConvertError('unsupported file type', 400)

  const deadline = Date.now() + opts.timeoutS * 1000
  const work = await mkdtemp(join(opts.workRoot, 'job-'))
  try {
    await mkdir(join(work, 'profile', 'user'), { recursive: true })
    await writeFile(join(work, 'profile', 'user', 'registrymodifications.xcu'), PROFILE_XCU)
    if (to === 'html') return { zip: await convertToHtml(work, input, deadline) }
    return { file: await convertBundle(work, input.bytes, to, deadline) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// --- import: Office file → ZIP with document.html, media/*, document.<odf> ---

async function convertToHtml(work: string, input: { bytes: Uint8Array; name: string }, deadline: number): Promise<Uint8Array> {
  const kind = officeKind(input.name)!
  const ext = extensionOf(input.name)
  // The user's file name never reaches the disk or the command line.
  const inFile = join(work, 'in', `document.${ext}`)
  await mkdir(dirname(inFile), { recursive: true })
  await writeFile(inFile, input.bytes)

  // Plain `html` picks Writer HTML, Impress XHTML or Calc HTML by document type
  // (probe 2026-10-16, Alpine 3.22).
  const outDir = join(work, 'out')
  await soffice(work, ['--convert-to', 'html', '--outdir', outDir, inFile], deadline)
  const outFiles = await listFiles(outDir)
  const htmlName =
    outFiles.find((f) => f === 'document.html') ?? outFiles.find((f) => /\.x?html?$/i.test(f))
  if (!htmlName) throw new ConvertError('LibreOffice produced no HTML output', 422)
  const rawHtml = await readFile(join(outDir, htmlName), 'utf8')
  if (rawHtml.trim() === '') throw new ConvertError('LibreOffice produced empty HTML output', 422)

  const odfExt = ODF_EXTENSION[kind]
  let odf: Uint8Array
  if (ext === odfExt) {
    odf = input.bytes
  } else {
    const odfDir = join(work, 'odf')
    await soffice(work, ['--convert-to', odfExt, '--outdir', odfDir, inFile], deadline)
    const bytes = await readNonEmpty(join(odfDir, `document.${odfExt}`))
    if (!bytes) throw new ConvertError(`LibreOffice produced no ${odfExt.toUpperCase()} output`, 422)
    odf = bytes
  }

  const otherFiles = outFiles.filter((f) => f !== htmlName)
  const extracted = extractMedia(rawHtml, new Set(otherFiles))
  const files: Record<string, Uint8Array> = {}
  // Images LibreOffice wrote as files move to media/.
  for (const f of otherFiles) files[`media/${f}`] = await readFile(join(outDir, f))
  for (const [path, bytes] of extracted.images) files[path] = bytes

  const failed = await chartsToSvg(work, extracted.charts, deadline, files)
  const html = failed.size ? dropCharts(extracted.html, failed) : extracted.html

  files['document.html'] = strToU8(html)
  files[`document.${odfExt}`] = odf
  return zipSync(files)
}

const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
const SRC_ATTR = /(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)')/i
const DATA_URI = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/x-emf': 'emf',
  'image/emf': 'emf',
  'image/x-wmf': 'wmf',
  'image/wmf': 'wmf',
}

function decodeDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = DATA_URI.exec(uri)
  if (!m) return null
  const mime = m[1].trim().toLowerCase()
  const isBase64 = /;base64$/i.test(m[2])
  try {
    const bytes = isBase64
      ? new Uint8Array(Buffer.from(m[3].replace(/\s+/g, ''), 'base64'))
      : strToU8(decodeURIComponent(m[3]))
    return { mime, bytes }
  } catch {
    return null
  }
}

function startsWithAscii(bytes: Uint8Array, s: string): boolean {
  if (bytes.length < s.length) return false
  for (let i = 0; i < s.length; i++) if (bytes[i] !== s.charCodeAt(i)) return false
  return true
}

function imageExtension(mime: string, bytes: Uint8Array): string {
  if (MIME_EXT[mime]) return MIME_EXT[mime]
  if (startsWithAscii(bytes, '\x89PNG')) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (startsWithAscii(bytes, 'GIF8')) return 'gif'
  return 'bin'
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Rewrites every `<img src>`: data URIs become `media/img-<n>.<ext>`, SVM data
 * (charts, SmartArt) becomes `media/chart-<n>.svg` (SVG made afterwards), and
 * references to files LibreOffice wrote next to the HTML get the `media/` prefix.
 * Counters are 1-based in document order — the adapter matches charts by order.
 */
function extractMedia(
  html: string,
  outFiles: ReadonlySet<string>,
): { html: string; images: Map<string, Uint8Array>; charts: Map<string, Uint8Array> } {
  const images = new Map<string, Uint8Array>()
  const charts = new Map<string, Uint8Array>()
  const out = html.replace(IMG_TAG, (tag) => {
    const src = SRC_ATTR.exec(tag)
    if (!src) return tag
    const value = src[2] ?? src[3] ?? ''
    let next: string | null = null
    if (/^data:/i.test(value)) {
      const data = decodeDataUri(value)
      if (!data) return tag
      if (startsWithAscii(data.bytes, 'VCLMTF')) {
        const name = `chart-${charts.size + 1}`
        charts.set(name, data.bytes)
        next = `media/${name}.svg`
      } else {
        next = `media/img-${images.size + 1}.${imageExtension(data.mime, data.bytes)}`
        images.set(next, data.bytes)
      }
    } else if (outFiles.has(value) || outFiles.has(safeDecode(value))) {
      next = `media/${outFiles.has(value) ? value : safeDecode(value)}`
    }
    if (next === null) return tag
    return tag.replace(SRC_ATTR, `${src[1]}"${next}"`)
  })
  return { html: out, images, charts }
}

/** Converts the SVM files with Draw; returns the chart names that failed. */
async function chartsToSvg(
  work: string,
  charts: Map<string, Uint8Array>,
  deadline: number,
  files: Record<string, Uint8Array>,
): Promise<Set<string>> {
  const failed = new Set<string>()
  if (charts.size === 0) return failed
  const svmDir = join(work, 'svm')
  const svgDir = join(work, 'svg')
  await mkdir(svmDir, { recursive: true })
  const inputs: string[] = []
  for (const [name, bytes] of charts) {
    const p = join(svmDir, `${name}.svm`)
    await writeFile(p, bytes)
    inputs.push(p)
  }
  try {
    await soffice(work, ['--convert-to', 'svg', '--outdir', svgDir, ...inputs], deadline)
  } catch (e) {
    // A timeout ends the job; any other failure only loses the charts.
    if (e instanceof ConvertError && e.status === 504) throw e
  }
  for (const name of charts.keys()) {
    const svg = await readNonEmpty(join(svgDir, `${name}.svg`))
    if (svg) files[`media/${name}.svg`] = cropToGraphic(svg)
    else failed.add(name)
  }
  return failed
}

/** Replaces the images of failed charts by a placeholder the adapter counts. */
function dropCharts(html: string, failed: ReadonlySet<string>): string {
  return html.replace(IMG_TAG, (tag) => {
    const src = SRC_ATTR.exec(tag)
    const value = src ? (src[2] ?? src[3] ?? '') : ''
    const m = /^media\/(chart-\d+)\.svg$/.exec(value)
    return m && failed.has(m[1]) ? '<span data-f451-dropped="chart"></span>' : tag
  })
}

// --- export: bundle ZIP (document.* + media/) → docx/pdf/pptx/xlsx ---

async function convertBundle(work: string, zip: Uint8Array, to: ExportTarget, deadline: number): Promise<Uint8Array> {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch {
    throw new ConvertError('the bundle is not a valid ZIP file', 400)
  }
  const inDir = join(work, 'in')
  let doc: string | null = null
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    const norm = posix.normalize(name)
    if (name.includes('\\') || posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../')) {
      throw new ConvertError('the bundle contains an invalid path', 400)
    }
    const target = join(inDir, norm)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    if (!norm.includes('/') && /^document\.[a-z0-9]+$/i.test(norm)) doc = norm
  }
  if (!doc) throw new ConvertError('the bundle has no document file', 400)

  const isHtml = /^(html?|xhtml)$/.test(extensionOf(doc))
  const { filter, infilter } = exportFilter(to, isHtml)
  const outDir = join(work, 'out')
  const args = [...(infilter ? [`--infilter=${infilter}`] : []), '--convert-to', filter, '--outdir', outDir, join(inDir, doc)]
  await soffice(work, args, deadline)
  const file = await readNonEmpty(join(outDir, `document.${to}`))
  if (!file) throw new ConvertError(`LibreOffice produced no ${to.toUpperCase()} output`, 422)
  return file
}

function exportFilter(to: ExportTarget, isHtml: boolean): { filter: string; infilter?: string } {
  switch (to) {
    // HTML opens as a Writer/Web document by default; the Word filter needs a
    // Writer document, hence the explicit import filter.
    case 'docx':
      return { filter: 'docx:MS Word 2007 XML', infilter: isHtml ? 'HTML (StarWriter)' : undefined }
    case 'pdf':
      return { filter: isHtml ? 'pdf:writer_web_pdf_Export' : 'pdf' }
    case 'pptx':
      return { filter: 'pptx:Impress MS PowerPoint 2007 XML' }
    case 'xlsx':
      return { filter: 'xlsx:Calc MS Excel 2007 XML', infilter: isHtml ? 'HTML (StarCalc)' : undefined }
  }
}

// --- process handling ---

async function soffice(work: string, args: string[], deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ConvertError('conversion timed out', 504)
  const argv = [
    '--headless',
    '--norestore',
    '--nologo',
    '--nolockcheck',
    `-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`,
    ...args,
  ]
  await new Promise<void>((resolve, reject) => {
    // Own process group, so a timeout kills soffice.bin and its helpers too.
    const child = spawn('soffice', argv, {
      cwd: work,
      env: { ...process.env, HOME: work, TMPDIR: work },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }, remaining)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new ConvertError(`LibreOffice could not be started: ${e.message}`, 422))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new ConvertError('conversion timed out', 504))
      else if (code !== 0) reject(new ConvertError(`LibreOffice failed (${code ?? signal}): ${lastLine(output)}`, 422))
      else resolve()
    })
  })
}

function lastLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.at(-1) ?? 'no output'
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

async function readNonEmpty(path: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(path)
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** Draw places a metafile on a whole default page (Letter), so the chart sits
 *  in a large empty canvas. The export marks the graphic's frame as
 *  `<rect class="BoundingBox" …>` inside `<g class="Graphic">` (directly or in
 *  one more `<g>`); the SVG is cut
 *  to that frame (viewBox in 1/100 mm, size in mm). Left as is without one. */
export function cropToGraphic(svg: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(svg)
  const box = /<g class="Graphic">\s*(?:<g\b[^>]*>\s*)?<rect class="BoundingBox"[^>]*?\sx="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(text)
  if (!box) return svg
  const [x, y, w, h] = box.slice(1).map(Number)
  if (!w || !h) return svg
  const cropped = text.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\swidth="[^"]*"/, ` width="${w / 100}mm"`)
      .replace(/\sheight="[^"]*"/, ` height="${h / 100}mm"`)
      .replace(/\sviewBox="[^"]*"/, ` viewBox="${x} ${y} ${w} ${h}"`),
  )
  return new TextEncoder().encode(cropped)
}
