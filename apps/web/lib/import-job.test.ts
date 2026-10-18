import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORD_FORM,
  eventHref,
  exceedsUploadLimit,
  fileImportForm,
  importAvailable,
  isJobView,
  parseImportOffer,
  nextState,
  progressPercent,
  reportFileName,
  storageKey,
  type JobView,
  type PanelState,
} from './import-job.js'

function view(over: Partial<JobView> = {}): JobView {
  return {
    id: 'j1',
    kind: 'import-bookstack',
    space: 'demo',
    status: 'running',
    startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: null,
    total: 10,
    done: 3,
    events: [],
    counts: {},
    report: null,
    phase: null,
    ...over,
  }
}

const running: PanelState = { kind: 'running', jobId: 'j1', view: null }

describe('nextState', () => {
  it('404 resets a running panel to the form', () => {
    expect(nextState(running, { status: 404 })).toEqual({ kind: 'form' })
  })

  it('200 with a running job stays running and carries the view', () => {
    const v = view()
    expect(nextState(running, { status: 200, view: v })).toEqual({ kind: 'running', jobId: 'j1', view: v })
  })

  it.each(['done', 'failed', 'cancelled'] as const)('200 with %s finishes', (status) => {
    const v = view({ status, finishedAt: '2026-10-14T10:01:00.000Z', report: '# Import report\n' })
    expect(nextState(running, { status: 200, view: v })).toEqual({ kind: 'finished', view: v })
  })

  it('a transient error keeps the previous state', () => {
    expect(nextState(running, { status: 'error' })).toBe(running)
    const form: PanelState = { kind: 'form' }
    expect(nextState(form, { status: 'error' })).toBe(form)
  })
})

describe('isJobView', () => {
  it('accepts a job view', () => {
    expect(isJobView(view())).toBe(true)
    expect(isJobView(view({ status: 'done', counts: { created: 2 } }))).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an HTML string', '<!doctype html><html></html>'],
    ['an empty object', {}],
    ['an array', []],
  ])('rejects %s', (_label, body) => {
    expect(isJobView(body)).toBe(false)
  })

  it.each([
    ['id', { id: 1 }],
    ['status', { status: undefined }],
    ['events', { events: {} }],
    ['counts (null)', { counts: null }],
    ['counts (array)', { counts: [] }],
    ['total', { total: '10' }],
    ['done', { done: undefined }],
  ])('rejects a view with a wrong %s', (_label, over) => {
    expect(isJobView({ ...view(), ...over })).toBe(false)
  })
})

describe('progressPercent', () => {
  it('is 0 while the total is 0', () => {
    expect(progressPercent(view({ total: 0, done: 0 }))).toBe(0)
  })

  it('rounds and clamps to 0..100', () => {
    expect(progressPercent(view({ total: 3, done: 1 }))).toBe(33)
    expect(progressPercent(view({ total: 2, done: 5 }))).toBe(100)
  })
})

describe('storageKey and reportFileName', () => {
  it('keys the stored job id by space', () => {
    expect(storageKey('demo')).toBe('f451:import-job:demo')
  })

  it('names the report by job kind', () => {
    expect(reportFileName('import-bookstack')).toBe('import-report.md')
    expect(reportFileName('import-file')).toBe('import-report.md')
    expect(reportFileName('export-bookstack')).toBe('export-report.md')
  })
})

describe('parseImportOffer and importAvailable', () => {
  it('reads the allow-list and the file import limit', () => {
    const offer = parseImportOffer({ bookstack: ['https://a', 3], fileImport: { maxUploadMb: 200 } })
    expect(offer).toEqual({ bookstack: ['https://a'], maxUploadMb: 200, office: false })
    expect(importAvailable(offer)).toBe(true)
  })
  it('reads the Office flag of the file import', () => {
    expect(parseImportOffer({ fileImport: { maxUploadMb: 200, office: true } }).office).toBe(true)
    expect(parseImportOffer({ fileImport: { maxUploadMb: 200, office: 'yes' } }).office).toBe(false)
  })
  it('treats a missing or malformed file import as absent', () => {
    expect(parseImportOffer({ bookstack: [] }).maxUploadMb).toBeNull()
    expect(parseImportOffer({ fileImport: { maxUploadMb: '200' } }).maxUploadMb).toBeNull()
    expect(parseImportOffer({ fileImport: { maxUploadMb: 0 } }).maxUploadMb).toBeNull()
    expect(parseImportOffer(null)).toEqual({ bookstack: [], maxUploadMb: null, office: false })
  })
  it('offers the page with either source', () => {
    expect(importAvailable({ bookstack: [], maxUploadMb: 50, office: false })).toBe(true)
    expect(importAvailable({ bookstack: ['https://a'], maxUploadMb: null, office: false })).toBe(true)
    expect(importAvailable({ bookstack: [], maxUploadMb: null, office: false })).toBe(false)
  })
})

describe('exceedsUploadLimit', () => {
  it('compares bytes against the limit in MiB', () => {
    expect(exceedsUploadLimit(2 * 1024 * 1024, 2)).toBe(false)
    expect(exceedsUploadLimit(2 * 1024 * 1024 + 1, 2)).toBe(true)
  })
})

describe('fileImportForm', () => {
  const opts = { format: 'obsidian' as const, parentId: ' p-1 ', update: true, release: false, dryRun: true }

  it('carries the options as text fields and the file last', () => {
    const form = fileImportForm(new Blob(['zip']), 'vault.zip', opts)
    expect([...form.keys()]).toEqual(['format', 'parentId', 'update', 'release', 'dryRun', 'file'])
    expect(form.get('format')).toBe('obsidian')
    expect(form.get('parentId')).toBe('p-1')
    expect(form.get('update')).toBe('true')
    expect(form.get('release')).toBe('false')
    expect(form.get('dryRun')).toBe('true')
    const file = form.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect((file as File).name).toBe('vault.zip')
  })

  it('sends the Word options of an office import; split options only with a split', () => {
    const word = { ...DEFAULT_WORD_FORM, mainName: 'id' as const, idPattern: ' DOC-### ', numbering: false }
    const plain = fileImportForm(new Blob(['x']), 'guide.docx', { ...opts, format: 'office', word })
    expect([...plain.keys()]).toEqual([
      'format', 'numbering', 'mainName', 'idPattern', 'idDisplay', 'parentId', 'update', 'release', 'dryRun', 'file',
    ])
    expect(plain.get('numbering')).toBe('false')
    expect(plain.get('idPattern')).toBe('DOC-###')

    const split = fileImportForm(new Blob(['x']), 'guide.docx', { ...opts, format: 'office', split: true, word })
    expect(split.get('splitLevel')).toBe('1')
    expect(split.get('subName')).toBe('chapter')
    expect(split.get('toc')).toBe('true')
    expect(split.get('tocDepth')).toBe('2')

    const other = fileImportForm(new Blob(['x']), 'v.zip', { ...opts, word })
    expect(other.has('numbering')).toBe(false)
  })

  it('leaves out an empty parent', () => {
    const form = fileImportForm(new Blob(['zip']), 'x.zip', { ...opts, parentId: '  ' })
    expect(form.has('parentId')).toBe(false)
  })
})

describe('eventHref', () => {
  it('follows the link the API chose for the event', () => {
    expect(eventHref('demo', { status: 'created', title: 'A', pageId: 'p-a', link: 'review' })).toBe('/wiki/demo/p-a/review')
    expect(eventHref('demo', { status: 'skipped', title: 'A', pageId: 'p-a', link: 'page' })).toBe('/wiki/demo/p-a')
  })
  it('has no link without a link target or a page id', () => {
    expect(eventHref('demo', { status: 'created', title: 'A', pageId: 'dry-3' })).toBeNull()
    expect(eventHref('demo', { status: 'failed', title: 'A', link: 'page' })).toBeNull()
  })
})
