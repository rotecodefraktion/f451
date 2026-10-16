import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { ConvertError, runSoffice } from './soffice.js'

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
  await writeFile(join(dir, 'fixture.html'), HTML)
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
  process.env.FAKE_SOFFICE_HTML = join(dir, 'fixture.html')
  log = join(dir, 'calls.log')
  process.env.FAKE_SOFFICE_LOG = log
})

afterAll(async () => {
  process.env.PATH = savedPath
  delete process.env.FAKE_SOFFICE_MODE
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  delete process.env.FAKE_SOFFICE_MODE
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
