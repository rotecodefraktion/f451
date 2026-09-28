import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NotFoundError, type GitProvider, type RepoRef } from '@f451/git-provider'
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  maxUploadBytes,
  uploadMedia,
  type UploadedFile,
} from '../src/drafts/upload.js'
import { InvalidSvgError } from '../src/drafts/svg-sanitize.js'

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

function fixtureBuffer(name: string): Buffer {
  return readFileSync(`${fixturesDir}${name}`)
}

const repo: RepoRef = { provider: 'forgejo', owner: 'acme', repo: 'docs' }
const pageId = 'anleitung'
const pagePath = 'betrieb/anleitung/index.md'

/** Minimaler In-Memory-GitProvider: nur `readFileBinary`/`writeFile`/
 *  `writeFileBinary` werden von `uploadMedia` benutzt — alles andere wirft,
 *  falls unerwartet aufgerufen (gleiches Muster wie
 *  `drafts-routes-permissions.test.ts`). */
function fakeProvider(): { provider: GitProvider; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  const unexpected = (name: string) => (): never => {
    throw new Error(`fakeProvider.${name}: im Test nicht erwartet`)
  }
  const provider: GitProvider = {
    readFile: unexpected('readFile'),
    async readFileBinary(_repo, path) {
      const content = files.get(path)
      if (content === undefined) throw new NotFoundError('nicht gefunden')
      return { content, sha: 'irrelevant' }
    },
    listTree: unexpected('listTree'),
    getHeadSha: unexpected('getHeadSha'),
    async writeFile(_repo, path, content) {
      files.set(path, Buffer.from(content, 'utf8'))
      return { commitSha: 'irrelevant' }
    },
    async writeFileBinary(_repo, path, content) {
      files.set(path, content)
      return { commitSha: 'irrelevant' }
    },
    createBranch: unexpected('createBranch'),
    deleteBranch: unexpected('deleteBranch'),
    listCommits: unexpected('listCommits'),
    createPullRequest: unexpected('createPullRequest'),
    getPullRequest: unexpected('getPullRequest'),
    mergePullRequest: unexpected('mergePullRequest'),
  }
  return { provider, files }
}

function png(): Buffer {
  return fixtureBuffer('minimal.png')
}

describe('uploadMedia (Phase 2a Task 5)', () => {
  it('PNG-Upload (Happy Path): committet nach <Seitenordner>/_media/<name>, Antwort laut Plan-Interface', async () => {
    const { provider, files } = fakeProvider()
    const file: UploadedFile = { filename: 'Diagramm.png', buffer: png() }

    const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

    expect(result).toEqual({ path: '_media/diagramm.png', markdown: '![](_media/diagramm.png)', kind: 'image' })
    expect(files.has('betrieb/anleitung/_media/diagramm.png')).toBe(true)
    expect(files.get('betrieb/anleitung/_media/diagramm.png')).toEqual(png())
  })

  it('Wurzelseite (pagePath ohne Verzeichnis): Medienordner ist "_media" ohne führendes Segment', async () => {
    const { provider, files } = fakeProvider()
    const file: UploadedFile = { filename: 'bild.png', buffer: png() }

    const result = await uploadMedia(provider, repo, 'home', 'index.md', file, maxUploadBytes())

    expect(result.path).toBe('_media/bild.png')
    expect(files.has('_media/bild.png')).toBe(true)
  })

  it('fake .png mit HTML-Inhalt → UnsupportedMediaTypeError (Magic-Bytes-Prüfung greift, Route mappt auf 415)', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'fake.png', buffer: Buffer.from('<html><body>kein Bild</body></html>') }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    )
  })

  it('Größenlimit überschritten → PayloadTooLargeError (Route mappt auf 413)', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'diagramm.png', buffer: png() }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, png().length - 1)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  it('nicht erlaubte Extension → UnsupportedMediaTypeError', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'bild.bmp', buffer: png() }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    )
  })

  it('Datei ohne Extension → UnsupportedMediaTypeError', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'ohneendung', buffer: png() }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    )
  })

  it('SVG mit Skript: committete Datei enthält kein <script/onload, Antwortpfad korrekt', async () => {
    const { provider, files } = fakeProvider()
    const file: UploadedFile = { filename: 'boese.svg', buffer: fixtureBuffer('script.svg') }

    const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

    expect(result.path).toBe('_media/boese.svg')
    const committed = files.get('betrieb/anleitung/_media/boese.svg')!.toString('utf8')
    expect(committed).not.toContain('<script')
    expect(committed).not.toContain('onload')
    expect(committed).not.toContain('onclick')
    expect(committed.toLowerCase()).not.toContain('javascript:')
  })

  it('draw.io-SVG: committete Datei behält das content-Attribut (mxfile)', async () => {
    const { provider, files } = fakeProvider()
    const file: UploadedFile = { filename: 'architektur.svg', buffer: fixtureBuffer('drawio.svg') }

    await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

    const committed = files.get('betrieb/anleitung/_media/architektur.svg')!.toString('utf8')
    expect(committed).toContain('content="')
    expect(committed).toContain('mxfile')
    expect(committed).toContain('<metadata')
  })

  it('SVG, das nach dem Sanitizing leer ist → InvalidSvgError (Route mappt auf 422)', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = {
      filename: 'leer.svg',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())).rejects.toBeInstanceOf(
      InvalidSvgError,
    )
  })

  it('Kollision: zweiter Upload desselben Namens bekommt -1, dritter -2', async () => {
    const { provider, files } = fakeProvider()
    const file = (): UploadedFile => ({ filename: 'diagramm.png', buffer: png() })

    const first = await uploadMedia(provider, repo, pageId, pagePath, file(), maxUploadBytes())
    const second = await uploadMedia(provider, repo, pageId, pagePath, file(), maxUploadBytes())
    const third = await uploadMedia(provider, repo, pageId, pagePath, file(), maxUploadBytes())

    expect(first.path).toBe('_media/diagramm.png')
    expect(second.path).toBe('_media/diagramm-1.png')
    expect(third.path).toBe('_media/diagramm-2.png')
    expect(files.has('betrieb/anleitung/_media/diagramm.png')).toBe(true)
    expect(files.has('betrieb/anleitung/_media/diagramm-1.png')).toBe(true)
    expect(files.has('betrieb/anleitung/_media/diagramm-2.png')).toBe(true)
  })

  it('slugifiziert den Dateinamen: Leerzeichen/Großschreibung/Sonderzeichen werden ersetzt', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'Mein Bild (Kopie)!.png', buffer: png() }

    const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

    expect(result.path).toMatch(/^_media\/[a-z0-9._-]+\.png$/)
  })

  it('Pfad-Traversal im Dateinamen wird neutralisiert (kein Escape aus dem Medienordner)', async () => {
    const { provider, files } = fakeProvider()
    const file: UploadedFile = { filename: '../../../etc/passwd.png', buffer: png() }

    const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

    expect(result.path.startsWith('_media/')).toBe(true)
    expect(result.path).not.toContain('..')
    expect(result.path).not.toContain('/etc/')
    const committedPaths = [...files.keys()]
    expect(committedPaths.every((p) => p.startsWith('betrieb/anleitung/_media/'))).toBe(true)
    expect(committedPaths.every((p) => !p.includes('..'))).toBe(true)
  })

  it('erkennt JPEG/GIF/WebP-Magic-Bytes korrekt (kein reiner PNG-Test)', async () => {
    const { provider } = fakeProvider()
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16)])
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(8),
    ])

    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'a.jpg', buffer: jpeg }, maxUploadBytes()),
    ).resolves.toMatchObject({ path: '_media/a.jpg' })
    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'b.gif', buffer: gif }, maxUploadBytes()),
    ).resolves.toMatchObject({ path: '_media/b.gif' })
    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'c.webp', buffer: webp }, maxUploadBytes()),
    ).resolves.toMatchObject({ path: '_media/c.webp' })
  })

  it('verwirft Magic-Bytes-Mismatch über alle Rasterformate (nicht nur PNG)', async () => {
    const { provider } = fakeProvider()
    const garbage = Buffer.from('kein Bild, nur Text')

    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'a.jpg', buffer: garbage }, maxUploadBytes()),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'b.gif', buffer: garbage }, maxUploadBytes()),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'c.webp', buffer: garbage }, maxUploadBytes()),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
  })
})

// --- Datei-Anhänge (PDF/Office/ZIP/Text) — Editor-Erweiterung "Nicht-Bild-Anhänge" ---
//
// Läuft PARALLEL zur Bild-Whitelist oben: `DOCUMENT_EXTENSION_WHITELIST`
// (pdf/docx/xlsx/pptx/zip/txt/csv/md). PDF und die ZIP-Container (docx/xlsx/pptx/
// zip selbst) werden per Magic-Bytes gegen die behauptete Extension geprüft
// (`%PDF-` bzw. `PK\x03\x04`) — txt/csv/md sind reine Textformate ohne
// Magic-Bytes-Konzept und laufen ohne Signaturprüfung durch (Größenlimit gilt
// weiterhin). Antwort trägt `kind: 'file'` und die Link-Markdown-Form (Original-
// Dateiname als Linktext) statt der Bild-Form.
describe('uploadMedia — Datei-Anhänge (PDF/Office/ZIP/Text)', () => {
  function pdfBuffer(): Buffer {
    return Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(16)])
  }

  function zipBuffer(): Buffer {
    return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)])
  }

  it('PDF-Upload (Happy Path): kind "file", Link-Markdown mit dem ORIGINAL-Dateinamen', async () => {
    const { provider, files } = fakeProvider()
    const file: UploadedFile = { filename: 'Betriebshandbuch.pdf', buffer: pdfBuffer() }

    const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

    expect(result).toEqual({
      path: '_media/betriebshandbuch.pdf',
      markdown: '[Betriebshandbuch.pdf](_media/betriebshandbuch.pdf)',
      kind: 'file',
    })
    expect(files.get('betrieb/anleitung/_media/betriebshandbuch.pdf')).toEqual(pdfBuffer())
  })

  it.each(['docx', 'xlsx', 'pptx', 'zip'])(
    'ZIP-Container-Upload (.%s, Happy Path): kind "file", PK-Signatur akzeptiert',
    async (ext) => {
      const { provider } = fakeProvider()
      const file: UploadedFile = { filename: `anhang.${ext}`, buffer: zipBuffer() }

      const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

      expect(result).toEqual({
        path: `_media/anhang.${ext}`,
        markdown: `[anhang.${ext}](_media/anhang.${ext})`,
        kind: 'file',
      })
    },
  )

  it.each(['txt', 'csv', 'md'])(
    'Textformat-Upload (.%s, Happy Path): kind "file", KEINE Magic-Bytes-Prüfung nötig',
    async (ext) => {
      const { provider, files } = fakeProvider()
      const buffer = Buffer.from('beliebiger Textinhalt, keine Signatur', 'utf8')
      const file: UploadedFile = { filename: `notizen.${ext}`, buffer }

      const result = await uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())

      expect(result).toEqual({
        path: `_media/notizen.${ext}`,
        markdown: `[notizen.${ext}](_media/notizen.${ext})`,
        kind: 'file',
      })
      expect(files.get(`betrieb/anleitung/_media/notizen.${ext}`)).toEqual(buffer)
    },
  )

  it('fake .pdf mit fremdem Inhalt → UnsupportedMediaTypeError (Magic-Bytes-Prüfung greift, Route mappt auf 415)', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'fake.pdf', buffer: Buffer.from('<html>kein PDF</html>') }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    )
  })

  it('fake .zip/.docx mit fremdem Inhalt → UnsupportedMediaTypeError (kein PK-Header)', async () => {
    const { provider } = fakeProvider()
    const garbage = Buffer.from('kein ZIP-Container, nur Text')

    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'fake.zip', buffer: garbage }, maxUploadBytes()),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
    await expect(
      uploadMedia(provider, repo, pageId, pagePath, { filename: 'fake.docx', buffer: garbage }, maxUploadBytes()),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
  })

  it('Dateityp außerhalb BEIDER Whitelists (Bild UND Dokument) → UnsupportedMediaTypeError', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'programm.exe', buffer: Buffer.from('MZ...') }

    await expect(uploadMedia(provider, repo, pageId, pagePath, file, maxUploadBytes())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    )
  })

  it('Größenlimit gilt auch für Datei-Anhänge → PayloadTooLargeError (Route mappt auf 413)', async () => {
    const { provider } = fakeProvider()
    const file: UploadedFile = { filename: 'notizen.txt', buffer: Buffer.from('x'.repeat(100)) }

    await expect(
      uploadMedia(provider, repo, pageId, pagePath, file, 99),
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('Kollision: zweiter Upload desselben Dokumentnamens bekommt -1', async () => {
    const { provider } = fakeProvider()
    const file = (): UploadedFile => ({ filename: 'bericht.pdf', buffer: pdfBuffer() })

    const first = await uploadMedia(provider, repo, pageId, pagePath, file(), maxUploadBytes())
    const second = await uploadMedia(provider, repo, pageId, pagePath, file(), maxUploadBytes())

    expect(first.path).toBe('_media/bericht.pdf')
    expect(second.path).toBe('_media/bericht-1.pdf')
    expect(second.markdown).toBe('[bericht.pdf](_media/bericht-1.pdf)')
  })
})
