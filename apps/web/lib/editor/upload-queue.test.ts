import { describe, expect, it } from 'vitest'
import {
  initialUploadQueueState,
  isUploadableFile,
  skippedFilesNotice,
  splitUploadFiles,
  uploadQueueReducer,
} from './upload-queue.js'
import { t as translate } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import type { T } from '../i18n/types.js'

// Phase-2-i18n: `skippedFilesNotice` bekommt `t` als Parameter (Modulkonvention,
// s. `lib/i18n/types.ts#T`) — hier an das DE-Wörterbuch gebunden, derselbe
// Wortlaut wie der bisherige Test.
const t: T = (key, params) => translate(de, key, params)

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('isUploadableFile', () => {
  it('akzeptiert Bilder per MIME-Type', () => {
    expect(isUploadableFile(file('a.png', 'image/png'))).toBe(true)
  })

  it('akzeptiert die erlaubten Dokument-Endungen (unabhängig vom MIME-Type)', () => {
    expect(isUploadableFile(file('handbuch.pdf', 'application/pdf'))).toBe(true)
    expect(isUploadableFile(file('bericht.docx', ''))).toBe(true)
    expect(isUploadableFile(file('zahlen.xlsx', ''))).toBe(true)
    expect(isUploadableFile(file('folien.pptx', ''))).toBe(true)
    expect(isUploadableFile(file('archiv.zip', 'application/zip'))).toBe(true)
    expect(isUploadableFile(file('notizen.txt', 'text/plain'))).toBe(true)
    expect(isUploadableFile(file('daten.csv', 'text/csv'))).toBe(true)
    expect(isUploadableFile(file('README.md', ''))).toBe(true)
  })

  it('lehnt nicht unterstützte Typen ab', () => {
    expect(isUploadableFile(file('archiv.rar', 'application/x-rar'))).toBe(false)
    expect(isUploadableFile(file('programm.exe', 'application/octet-stream'))).toBe(false)
    expect(isUploadableFile(file('ohneendung', ''))).toBe(false)
  })
})

describe('splitUploadFiles — Finding 1: Mehrfach-Drop/-Paste darf nichts verwerfen', () => {
  it('sammelt ALLE Bilddateien eines Events, in Event-Reihenfolge', () => {
    const a = file('a.png', 'image/png')
    const b = file('b.jpg', 'image/jpeg')
    const c = file('c.gif', 'image/gif')
    const { uploadable, skippedCount } = splitUploadFiles([a, b, c])
    expect(uploadable).toEqual([a, b, c])
    expect(skippedCount).toBe(0)
  })

  it('sammelt Bilder UND Dokument-Anhänge im selben Event, Reihenfolge bleibt erhalten', () => {
    const a = file('a.png', 'image/png')
    const doc = file('notes.pdf', 'application/pdf')
    const b = file('b.png', 'image/png')
    const { uploadable, skippedCount } = splitUploadFiles([a, doc, b])
    expect(uploadable).toEqual([a, doc, b])
    expect(skippedCount).toBe(0)
  })

  it('trennt hochladbare Dateien von wirklich nicht unterstützten im selben Event', () => {
    const a = file('a.png', 'image/png')
    const unsupported = file('archiv.rar', 'application/x-rar')
    const b = file('b.pdf', 'application/pdf')
    const { uploadable, skippedCount } = splitUploadFiles([a, unsupported, b])
    expect(uploadable).toEqual([a, b])
    expect(skippedCount).toBe(1)
  })

  it('liefert eine leere Liste, wenn nur nicht unterstützte Dateien dabei sind (kein stilles Verwerfen — skippedCount zählt sie)', () => {
    const rar = file('notes.rar', 'application/x-rar')
    const exe = file('programm.exe', 'application/octet-stream')
    const { uploadable, skippedCount } = splitUploadFiles([rar, exe])
    expect(uploadable).toEqual([])
    expect(skippedCount).toBe(2)
  })

  it('leeres Event → leere Liste, skippedCount 0', () => {
    expect(splitUploadFiles([])).toEqual({ uploadable: [], skippedCount: 0 })
  })
})

describe('skippedFilesNotice — Sammel-Notice statt stillen Verwerfens', () => {
  it('Singular bei genau einer übersprungenen Datei', () => {
    expect(skippedFilesNotice(1, t)).toBe('1 Datei übersprungen — nicht unterstützter Dateityp.')
  })

  it('Plural mit Zahl bei mehreren übersprungenen Dateien', () => {
    expect(skippedFilesNotice(3, t)).toBe('3 Dateien übersprungen — nicht unterstützter Dateityp.')
  })
})

describe('uploadQueueReducer — Finding 2: Zähler + Fehlersammlung statt Überschreiben', () => {
  it('initialer Zustand: keine aktiven Uploads, keine Fehler', () => {
    expect(initialUploadQueueState).toEqual({ active: 0, errors: [] })
  })

  it('"start" erhöht den Zähler um die übergebene Anzahl (ein Event kann mehrere Uploads anstoßen)', () => {
    const state = uploadQueueReducer(initialUploadQueueState, { type: 'start', count: 3 })
    expect(state).toEqual({ active: 3, errors: [] })
  })

  it('"success" dekrementiert den Zähler, lässt Fehler unangetastet', () => {
    const started = uploadQueueReducer(initialUploadQueueState, { type: 'start', count: 2 })
    const state = uploadQueueReducer(started, { type: 'success' })
    expect(state).toEqual({ active: 1, errors: [] })
  })

  it('"error" dekrementiert den Zähler UND hängt die Meldung an (statt sie zu ersetzen)', () => {
    const started = uploadQueueReducer(initialUploadQueueState, { type: 'start', count: 1 })
    const state = uploadQueueReducer(started, { type: 'error', message: 'kaputt.png: zu groß' })
    expect(state).toEqual({ active: 0, errors: ['kaputt.png: zu groß'] })
  })

  it('Zähler wird nie negativ (Schutz gegen Fehlaufrufe ohne vorheriges "start")', () => {
    const state = uploadQueueReducer(initialUploadQueueState, { type: 'success' })
    expect(state.active).toBe(0)
  })

  it('KERNFALL Finding 2: zwei gleichzeitig laufende Uploads sammeln BEIDE Fehler, keiner überschreibt den anderen', () => {
    let state = initialUploadQueueState
    // Datei-Dialog startet einen Upload …
    state = uploadQueueReducer(state, { type: 'start', count: 1 })
    // … während er noch läuft, startet ein Drop einen zweiten (active war > 0,
    // die bestehende Fehlerliste bleibt deshalb stehen statt geleert zu werden).
    state = uploadQueueReducer(state, { type: 'start', count: 1 })
    expect(state).toEqual({ active: 2, errors: [] })

    state = uploadQueueReducer(state, { type: 'error', message: 'A ist fehlgeschlagen' })
    expect(state).toEqual({ active: 1, errors: ['A ist fehlgeschlagen'] })

    state = uploadQueueReducer(state, { type: 'error', message: 'B ist fehlgeschlagen' })
    expect(state).toEqual({ active: 0, errors: ['A ist fehlgeschlagen', 'B ist fehlgeschlagen'] })
  })

  it('ein neuer Batch NACH vollständigem Abschluss (active === 0) startet mit einer frischen Fehlerliste', () => {
    let state = initialUploadQueueState
    state = uploadQueueReducer(state, { type: 'start', count: 1 })
    state = uploadQueueReducer(state, { type: 'error', message: 'alter Fehler' })
    expect(state).toEqual({ active: 0, errors: ['alter Fehler'] })

    state = uploadQueueReducer(state, { type: 'start', count: 1 })
    expect(state).toEqual({ active: 1, errors: [] })
  })

  it('mehrere Bilder aus EINEM Drop (count > 1) sammeln ebenfalls alle Fehler, keins wird überschrieben', () => {
    let state = uploadQueueReducer(initialUploadQueueState, { type: 'start', count: 3 })
    state = uploadQueueReducer(state, { type: 'error', message: 'erstes' })
    state = uploadQueueReducer(state, { type: 'success' })
    state = uploadQueueReducer(state, { type: 'error', message: 'drittes' })
    expect(state).toEqual({ active: 0, errors: ['erstes', 'drittes'] })
  })
})
