import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { ConvertError, cropToGraphic, runSoffice } from './soffice.js'

// A fake `soffice` on the PATH. Behaviour per FAKE_SOFFICE_MODE:
// ok (default), svgfail (no SVG output), empty (writes nothing),
// fail (exit 1), sleep (hangs). Every call is logged to FAKE_SOFFICE_LOG.
const FAKE = `#!/bin/sh
log="$FAKE_SOFFICE_LOG"
mode="\${FAKE_SOFFICE_MODE:-ok}"
to=""; out=""; profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --convert-to) to="$2"; shift 2 ;;
    --outdir) out="$2"; shift 2 ;;
    --infilter=*) echo "infilter \${1#--infilter=}" >> "$log"; shift ;;
    -env:UserInstallation=file://*) profile="\${1#-env:UserInstallation=file://}"; shift ;;
    -*) shift ;;
    *)
      f="$1"; shift
      echo "convert $to" >> "$log"
      if grep -q DisableMacrosExecution "$profile/user/registrymodifications.xcu" 2>/dev/null; then
        echo "profile-ok" >> "$log"
      fi
      case "$mode" in
        sleep) sleep 30 ;;
        empty) ;;
        fail) echo "Error: source file could not be loaded" >&2; exit 1 ;;
        *)
          mkdir -p "$out"
          base=$(basename "$f"); stem="\${base%.*}"; ext="\${to%%:*}"
          case "$ext" in
            html)
              cp "$FAKE_SOFFICE_HTML" "$out/$stem.html"
              printf 'PNGDATA' > "$out/\${stem}_html_1a2b.png" ;;
            svg)
              if [ "$mode" != svgfail ]; then printf '<svg xmlns="http://www.w3.org/2000/svg"/>' > "$out/$stem.svg"; fi ;;
            *)
              printf 'converted:%s' "$ext" > "$out/$stem.$ext" ;;
          esac ;;
      esac ;;
  esac
done
exit 0
`

// Fake poppler tools: a two-page PDF; FAKE_POPPLER_MODE=fail makes pdftocairo fail.
const FAKE_PDFINFO = `#!/bin/sh
echo "pdfinfo" >> "$FAKE_SOFFICE_LOG"
printf 'Producer:       fake\\nPages:          2\\n'
`
const FAKE_PDFTOCAIRO = `#!/bin/sh
if [ "$FAKE_POPPLER_MODE" = fail ]; then echo "Syntax Error: broken" >&2; exit 1; fi
page=""
while [ $# -gt 2 ]; do
  case "$1" in
    -f) page="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "pdftocairo $page" >> "$FAKE_SOFFICE_LOG"
printf '<svg xmlns="http://www.w3.org/2000/svg"><title>page %s</title></svg>' "$page" > "$2"
`

const HTML = `<html><body>
<p><img src="document_html_1a2b.png" alt="file"></p>
<p><img alt="inline" src="data:image/png;base64,iVBORw0KGgo="></p>
<p><img src="data:;base64,VkNMTVRGAQ==" alt="chart"></p>
</body></html>`

let dir: string
let workRoot: string
let log: string
const savedPath = process.env.PATH

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'f451-soffice-test-'))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'soffice'), FAKE)
  await chmod(join(bin, 'soffice'), 0o755)
  await writeFile(join(bin, 'pdfinfo'), FAKE_PDFINFO)
  await chmod(join(bin, 'pdfinfo'), 0o755)
  await writeFile(join(bin, 'pdftocairo'), FAKE_PDFTOCAIRO)
  await chmod(join(bin, 'pdftocairo'), 0o755)
  await writeFile(join(dir, 'fixture.html'), HTML)
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
  process.env.FAKE_SOFFICE_HTML = join(dir, 'fixture.html')
  log = join(dir, 'calls.log')
  process.env.FAKE_SOFFICE_LOG = log
})

afterAll(async () => {
  process.env.PATH = savedPath
  delete process.env.FAKE_SOFFICE_MODE
  delete process.env.FAKE_POPPLER_MODE
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  delete process.env.FAKE_SOFFICE_MODE
  delete process.env.FAKE_POPPLER_MODE
  await writeFile(log, '')
  workRoot = await mkdtemp(join(dir, 'work-'))
})

const docx = { bytes: strToU8('PK fake docx'), name: 'Bericht 2026.docx' }
const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)

async function rejection(p: Promise<unknown>): Promise<ConvertError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(ConvertError)
  return e as ConvertError
}

describe('runSoffice to=html', () => {
  it('returns document.html, media and the ODF copy', async () => {
    const r = await runSoffice(docx, 'html', { timeoutS: 10, workRoot })
    if (!('zip' in r)) throw new Error('expected a zip')
    const files = unzipSync(r.zip)
    expect(Object.keys(files).sort()).toEqual([
      'document.html',
      'document.odt',
      'media/chart-1.svg',
      'media/document_html_1a2b.png',
      'media/img-1.png',
    ])
    const html = strFromU8(files['document.html'])
    expect(html).toContain('src="media/document_html_1a2b.png"')
    expect(html).toContain('src="media/img-1.png"')
    expect(html).toContain('src="media/chart-1.svg"')
    expect(html).not.toContain('data:')
    expect(strFromU8(files['document.odt'])).toBe('converted:odt')
    expect(strFromU8(files['media/document_html_1a2b.png'])).toBe('PNGDATA')
    expect(Array.from(files['media/img-1.png'].slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('converts html, ODF and SVM with a macro-safe profile', async () => {
    await runSoffice(docx, 'html', { timeoutS: 10, workRoot })
    const lines = await calls()
    expect(lines.filter((l) => l.startsWith('convert'))).toEqual(['convert html', 'convert odt', 'convert svg'])
    expect(lines.filter((l) => l === 'profile-ok')).toHaveLength(3)
  })

  it('picks the ODF format by kind', async () => {
    const r = await runSoffice({ bytes: strToU8('x'), name: 'deck.PPTX' }, 'html', { timeoutS: 10, workRoot })
    if (!('zip' in r)) throw new Error('expected a zip')
    expect(Object.keys(unzipSync(r.zip))).toContain('document.odp')
  })

  it('renders one SVG per slide of a presentation through PDF and poppler', async () => {
    const r = await runSoffice({ bytes: strToU8('x'), name: 'deck.pptx' }, 'html', { timeoutS: 10, workRoot })
    if (!('zip' in r)) throw new Error('expected a zip')
    const files = unzipSync(r.zip)
    expect(Object.keys(files).filter((f) => f.startsWith('slides/')).sort()).toEqual(['slides/slide-1.svg', 'slides/slide-2.svg'])
    expect(strFromU8(files['slides/slide-2.svg'])).toContain('page 2')
    const lines = await calls()
    expect(lines).toContain('convert pdf')
    expect(lines.filter((l) => l.startsWith('pdftocairo'))).toEqual(['pdftocairo 1', 'pdftocairo 2'])
  })

  it('renders no slide images for a text document', async () => {
    const r = await runSoffice(docx, 'html', { timeoutS: 10, workRoot })
    if (!('zip' in r)) throw new Error('expected a zip')
    expect(Object.keys(unzipSync(r.zip)).some((f) => f.startsWith('slides/'))).toBe(false)
    expect(await calls()).not.toContain('pdfinfo')
  })

  it('still returns the HTML bundle, without slide images, when poppler fails', async () => {
    process.env.FAKE_POPPLER_MODE = 'fail'
    const r = await runSoffice({ bytes: strToU8('x'), name: 'deck.pptx' }, 'html', { timeoutS: 10, workRoot })
    if (!('zip' in r)) throw new Error('expected a zip')
    const files = unzipSync(r.zip)
    expect(files['document.html']).toBeDefined()
    expect(files['document.odp']).toBeDefined()
    expect(Object.keys(files).some((f) => f.startsWith('slides/'))).toBe(false)
  })

  it('skips slide images when little time is left', async () => {
    // 6 s budget minus the 2 s reserve leaves less than the 5 s minimum.
    await runSoffice({ bytes: strToU8('x'), name: 'deck.pptx' }, 'html', { timeoutS: 6, workRoot })
    expect(await calls()).not.toContain('convert pdf')
  })

  it('replaces a chart that could not be made by a counted placeholder', async () => {
    process.env.FAKE_SOFFICE_MODE = 'svgfail'
    const r = await runSoffice(docx, 'html', { timeoutS: 10, workRoot })
    if (!('zip' in r)) throw new Error('expected a zip')
    const files = unzipSync(r.zip)
    expect(files['media/chart-1.svg']).toBeUndefined()
    const html = strFromU8(files['document.html'])
    expect(html).toContain('<span data-f451-dropped="chart"></span>')
    expect(html).not.toContain('chart-1.svg')
    expect(html).toContain('src="media/img-1.png"')
  })

  it('removes the work dir afterwards', async () => {
    await runSoffice(docx, 'html', { timeoutS: 10, workRoot })
    expect(await readdir(workRoot)).toEqual([])
  })

  it('rejects an unknown extension with 400', async () => {
    const e = await rejection(runSoffice({ bytes: strToU8('x'), name: 'notes.txt' }, 'html', { timeoutS: 10, workRoot }))
    expect(e.status).toBe(400)
  })

  it('answers 422 when LibreOffice writes nothing', async () => {
    process.env.FAKE_SOFFICE_MODE = 'empty'
    const e = await rejection(runSoffice(docx, 'html', { timeoutS: 10, workRoot }))
    expect(e.status).toBe(422)
    expect(await readdir(workRoot)).toEqual([])
  })

  it('answers 422 with the reason when LibreOffice fails', async () => {
    process.env.FAKE_SOFFICE_MODE = 'fail'
    const e = await rejection(runSoffice(docx, 'html', { timeoutS: 10, workRoot }))
    expect(e.status).toBe(422)
    expect(e.message).toContain('source file could not be loaded')
  })

  it('kills a hanging conversion after the timeout with 504', async () => {
    process.env.FAKE_SOFFICE_MODE = 'sleep'
    const t0 = Date.now()
    const e = await rejection(runSoffice(docx, 'html', { timeoutS: 1, workRoot }))
    expect(e.status).toBe(504)
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(await readdir(workRoot)).toEqual([])
  })
})

describe('runSoffice export', () => {
  it('converts the document of an HTML bundle, with the Calc import filter for xlsx', async () => {
    const bundle = zipSync({ 'document.html': strToU8('<p>x</p>'), 'media/a.png': strToU8('png') })
    const r = await runSoffice({ bytes: bundle, name: 'bundle.zip' }, 'xlsx', { timeoutS: 10, workRoot })
    if (!('file' in r)) throw new Error('expected a file')
    expect(strFromU8(r.file)).toBe('converted:xlsx')
    const lines = await calls()
    expect(lines).toContain('infilter HTML (StarCalc)')
    expect(lines).toContain('convert xlsx:Calc MS Excel 2007 XML')
  })

  it('uses the Writer/Web PDF filter for HTML', async () => {
    const bundle = zipSync({ 'document.html': strToU8('<p>x</p>') })
    await runSoffice({ bytes: bundle, name: 'bundle.zip' }, 'pdf', { timeoutS: 10, workRoot })
    expect(await calls()).toContain('convert pdf:writer_web_pdf_Export')
  })

  it('converts a Flat ODP bundle to pptx without an import filter', async () => {
    const bundle = zipSync({ 'document.fodp': strToU8('<office:document/>') })
    const r = await runSoffice({ bytes: bundle, name: 'bundle.zip' }, 'pptx', { timeoutS: 10, workRoot })
    if (!('file' in r)) throw new Error('expected a file')
    expect(strFromU8(r.file)).toBe('converted:pptx')
    expect((await calls()).some((l) => l.startsWith('infilter'))).toBe(false)
  })

  it('rejects a bundle without a document file with 400', async () => {
    const bundle = zipSync({ 'media/a.png': strToU8('png') })
    const e = await rejection(runSoffice({ bytes: bundle, name: 'bundle.zip' }, 'docx', { timeoutS: 10, workRoot }))
    expect(e.status).toBe(400)
  })

  it('rejects a bundle with a path outside the work dir with 400', async () => {
    const bundle = zipSync({ 'document.html': strToU8('x'), '../evil.txt': strToU8('x') })
    const e = await rejection(runSoffice({ bytes: bundle, name: 'bundle.zip' }, 'docx', { timeoutS: 10, workRoot }))
    expect(e.status).toBe(400)
    expect(await readdir(workRoot)).toEqual([])
  })
})

describe('cropToGraphic', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const dec = (b: Uint8Array) => new TextDecoder().decode(b)

  it('cuts the page-sized SVG to the graphic frame', () => {
    const svg = '<svg version="1.2" width="215.9mm" height="279.4mm" viewBox="0 0 21590 27940"><g class="Graphic">\n <g id="id3">\n  <rect class="BoundingBox" stroke="none" fill="none" x="3175" y="8890" width="15240" height="10160"/></g></g></svg>'
    const out = dec(cropToGraphic(enc(svg)))
    expect(out).toContain('width="152.4mm" height="101.6mm" viewBox="3175 8890 15240 10160"')
  })

  it('leaves an SVG without a graphic frame as it is', () => {
    const svg = '<svg width="1mm" height="1mm" viewBox="0 0 100 100"></svg>'
    expect(dec(cropToGraphic(enc(svg)))).toBe(svg)
  })
})
