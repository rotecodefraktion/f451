'use client'

/**
 * Import/export panel (#128, #90) — the client island of
 * `app/wiki/[space]/(shell)/import/page.tsx`. Starts a BookStack import or
 * export, or a file import (ZIP upload of a Markdown folder or Obsidian
 * vault), as a job in the API and polls `GET /api/jobs/:id` until it ends.
 *
 * The job id is kept in `sessionStorage` (per space) so a reload or a second
 * visit reattaches to the running job; a 404 from the poll (API restart,
 * expiry) clears it and shows the form again. The BookStack token never
 * leaves component state: it is sent with the catalog/start request only.
 *
 * Fetches go relative over the Next rewrites with the session cookie, as in
 * `lib/editor/client-api.ts`; a 401 sends the user to the login page.
 */
import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  DEFAULT_WORD_FORM,
  EXPORT_FORMATS,
  eventHref,
  exceedsUploadLimit,
  fileAccept,
  fileImportForm,
  idPatternValid,
  isJobView,
  nextState,
  progressPercent,
  reportFileName,
  storageKey,
  type ExportFormat,
  type FileFormat,
  type JobView,
  type PanelState,
  type PollResult,
  type WordFormOptions,
} from '../lib/import-job'
import { useT } from '../lib/i18n/provider'
import { waitingReviews } from '../lib/reviews-state'
import {
  apiImportCatalogPath,
  apiJobCancelPath,
  apiJobFilePath,
  apiJobPath,
  apiSpaceExportPath,
  apiSpaceFileExportPath,
  apiSpaceFileImportPath,
  apiSpaceImportPath,
  wikiReviewsHref,
} from '../lib/urls'

const POLL_MS = 1000

const LEVELS: Array<readonly [string, string]> = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
]

/** A labelled select in the style of the form's other selects. */
function OptionSelect({
  inputId,
  label,
  value,
  options,
  onChange,
}: {
  inputId: string
  label: string
  value: string
  options: ReadonlyArray<readonly [string, string]>
  onChange: (value: string) => void
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      <div className="selectwrap">
        <select id={inputId} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </div>
    </div>
  )
}

type Tab = 'import' | 'export'
type Origin = 'bookstack' | 'file'
type ExportTarget = 'bookstack' | 'file'
type SourceKind = 'book' | 'shelf' | 'page'

interface Catalog {
  shelves: { id: number | string; name: string; books: number[] }[]
  books: { id: number | string; name: string; slug: string }[]
}

interface Notice {
  tone: 'error' | 'info'
  text: string
}

interface CallResult {
  status: number
  body: Record<string, unknown>
}

class SessionExpired extends Error {}

/** Same-origin fetch; 401 redirects to the login page (pattern
 *  `client-api.ts#redirectToLogin`). Network errors throw. */
async function call(path: string, init: RequestInit = {}): Promise<CallResult> {
  const res = await fetch(path, { ...init, credentials: 'same-origin' })
  if (res.status === 401) {
    const target = `${window.location.pathname}${window.location.search}`
    window.location.href = `/?next=${encodeURIComponent(target)}`
    throw new SessionExpired()
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  return { status: res.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} }
}

function postJson(path: string, payload: unknown): Promise<CallResult> {
  return call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

/** Server message of an error answer (`{status, reason}` or `{error}`). */
function serverMessage(body: Record<string, unknown>): string | null {
  if (typeof body.reason === 'string' && body.reason) return body.reason
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}

function readStored(space: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(space))
  } catch {
    return null
  }
}

function writeStored(space: string, id: string): void {
  try {
    window.sessionStorage.setItem(storageKey(space), id)
  } catch {
    // Storage unavailable (private mode, quota): reattach after reload is lost, the run is not.
  }
}

function clearStored(space: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(space))
  } catch {
    // see writeStored
  }
}

/** Whole, non-negative number from a text field; `null` if not one. */
function parseWhole(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null
}

export interface ImportPanelProps {
  space: string
  /** BookStack allow-list; empty → BookStack import and export are off. */
  instances: string[]
  /** Upload limit of the file import in MB; null → file import is off. */
  maxUploadMb: number | null
  /** The API has a convert service: offer the Office format. */
  office: boolean
}

export function ImportPanel({ space, instances, maxUploadMb, office }: ImportPanelProps) {
  const { t, messages } = useT()
  const uid = useId()
  const id = (name: string) => `${uid}-${name}`

  const hasBookstack = instances.length > 0
  const hasFile = maxUploadMb !== null

  const [panel, setPanel] = useState<PanelState>({ kind: 'form' })
  const [notice, setNotice] = useState<Notice | null>(null)

  const [tab, setTab] = useState<Tab>('import')
  const [origin, setOrigin] = useState<Origin>(hasBookstack ? 'bookstack' : 'file')
  const [fileFormat, setFileFormat] = useState<FileFormat>('markdown')
  const [file, setFile] = useState<File | null>(null)
  const [split, setSplit] = useState(false)
  const [word, setWord] = useState<WordFormOptions>(DEFAULT_WORD_FORM)
  const [instance, setInstance] = useState(instances[0] ?? '')
  const [tokenId, setTokenId] = useState('')
  const [tokenSecret, setTokenSecret] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const [sourceKind, setSourceKind] = useState<SourceKind>('book')
  const [sourceValue, setSourceValue] = useState('')
  const [parentId, setParentId] = useState('')
  const [update, setUpdate] = useState(false)
  const [release, setRelease] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [startPageId, setStartPageId] = useState('')
  const [bookId, setBookId] = useState('')
  const [exportTarget, setExportTarget] = useState<ExportTarget>(hasBookstack ? 'bookstack' : 'file')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('docx')
  const [exportSubpages, setExportSubpages] = useState(false)

  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // Reattach to a job started earlier in this tab (reload, back navigation).
  useEffect(() => {
    const stored = readStored(space)
    if (stored) setPanel({ kind: 'running', jobId: stored, view: null })
  }, [space])

  const runningJobId = panel.kind === 'running' ? panel.jobId : null

  // Poll the running job once per second until it ends or disappears.
  useEffect(() => {
    if (!runningJobId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      let poll: PollResult
      try {
        const r = await call(apiJobPath(runningJobId))
        // A 200 with a foreign body (proxy HTML, `{}`) counts as transient: keep polling.
        if (r.status === 200 && isJobView(r.body)) poll = { status: 200, view: r.body }
        else if (r.status === 404) poll = { status: 404 }
        else poll = { status: 'error' }
      } catch (err) {
        if (err instanceof SessionExpired) return
        poll = { status: 'error' }
      }
      if (stopped) return
      if (poll.status === 404) clearStored(space)
      setPanel((prev) => (prev.kind === 'running' && prev.jobId === runningJobId ? nextState(prev, poll) : prev))
      const ended = poll.status === 404 || (poll.status === 200 && poll.view.status !== 'running')
      if (!ended) timer = setTimeout(tick, POLL_MS)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runningJobId, space])

  function attach(jobId: string) {
    writeStored(space, jobId)
    setPanel({ kind: 'running', jobId, view: null })
  }

  const credentialsReady = instance !== '' && tokenId.trim() !== '' && tokenSecret !== ''

  async function loadCatalog() {
    if (!credentialsReady) return
    setCatalogBusy(true)
    setCatalogError(null)
    try {
      const r = await postJson(apiImportCatalogPath(), { instance, tokenId: tokenId.trim(), tokenSecret })
      if (r.status === 200 && Array.isArray(r.body.books) && Array.isArray(r.body.shelves)) {
        setCatalog(r.body as unknown as Catalog)
        setSourceValue('')
      } else {
        setCatalogError(serverMessage(r.body) ?? t('import.errors.catalogFailed'))
      }
    } catch (err) {
      if (!(err instanceof SessionExpired)) setCatalogError(t('import.errors.catalogFailed'))
    } finally {
      setCatalogBusy(false)
    }
  }

  /** Request body for the active tab, or an error text for the form. */
  function buildBody(): { body: Record<string, unknown> } | { error: string } {
    if (!credentialsReady) return { error: t('import.errors.missingFields') }
    const base = { instance, tokenId: tokenId.trim(), tokenSecret, dryRun }
    if (tab === 'import') {
      let source: Record<string, string | number>
      if (sourceKind === 'page') {
        const page = parseWhole(sourceValue)
        if (page === null) return { error: t('import.errors.invalidNumber') }
        source = { page }
      } else {
        const value = sourceValue.trim()
        if (!value) return { error: t('import.errors.missingFields') }
        source = sourceKind === 'book' ? { book: value } : { shelf: value }
      }
      const parent = parentId.trim()
      return { body: { ...base, source, ...(parent ? { parentId: parent } : {}), update, release } }
    }
    const startPage = startPageId.trim()
    let book: number | null = null
    if (bookId.trim()) {
      book = parseWhole(bookId)
      if (book === null) return { error: t('import.errors.invalidNumber') }
    }
    return { body: { ...base, ...(startPage ? { pageId: startPage } : {}), ...(book !== null ? { bookId: book } : {}) } }
  }

  const isFileImport = tab === 'import' && origin === 'file' && hasFile
  const isFileExport = tab === 'export' && exportTarget === 'file' && office

  function switchOrigin(next: Origin) {
    setOrigin(next)
    setFile(null)
    setNotice(null)
  }

  /** Multipart body of a file import, or an error text for the form. */
  function buildFileForm(): { form: FormData } | { error: string } {
    if (!file) return { error: t('import.errors.missingFile') }
    if (maxUploadMb !== null && exceedsUploadLimit(file.size, maxUploadMb)) {
      return { error: t('import.errors.tooLarge', { max: maxUploadMb }) }
    }
    if (fileFormat === 'office' && word.mainName === 'id') {
      const pattern = word.idPattern.trim()
      if (!pattern) return { error: t('import.errors.missingIdPattern') }
      if (!idPatternValid(pattern)) return { error: t('import.errors.invalidIdPattern') }
    }
    return { form: fileImportForm(file, file.name, { format: fileFormat, split, word, parentId, update, release, dryRun }) }
  }

  async function onStart(event: FormEvent) {
    event.preventDefault()
    setNotice(null)
    let request: () => Promise<CallResult>
    if (isFileExport) {
      const page = startPageId.trim()
      if (!page) {
        setNotice({ tone: 'error', text: t('import.errors.missingStartPage') })
        return
      }
      const payload = { pageId: page, format: exportFormat, subpages: exportSubpages }
      request = () => postJson(apiSpaceFileExportPath(space), payload)
    } else if (isFileImport) {
      const built = buildFileForm()
      if ('error' in built) {
        setNotice({ tone: 'error', text: built.error })
        return
      }
      // No content-type header: the browser sets the multipart boundary.
      request = () => call(apiSpaceFileImportPath(space), { method: 'POST', body: built.form })
    } else {
      const built = buildBody()
      if ('error' in built) {
        setNotice({ tone: 'error', text: built.error })
        return
      }
      const path = tab === 'import' ? apiSpaceImportPath(space) : apiSpaceExportPath(space)
      request = () => postJson(path, built.body)
    }
    setStarting(true)
    try {
      const r = await request()
      const jobId = typeof r.body.jobId === 'string' ? r.body.jobId : null
      if ((r.status === 202 || r.status === 200) && jobId) {
        attach(jobId)
      } else if (r.status === 409 && jobId) {
        setNotice({ tone: 'info', text: t('import.errors.busy') })
        attach(jobId)
      } else if (r.status === 429) {
        setNotice({ tone: 'error', text: t('import.errors.full') })
      } else if (r.status === 403) {
        setNotice({ tone: 'error', text: t('import.errors.forbidden') })
      } else if (r.status === 404) {
        setNotice({ tone: 'error', text: t('import.errors.notFound') })
      } else if (r.status === 413 && maxUploadMb !== null) {
        setNotice({ tone: 'error', text: t('import.errors.tooLarge', { max: maxUploadMb }) })
      } else if (r.status === 400 && isFileImport) {
        setNotice({ tone: 'error', text: serverMessage(r.body) ?? t('import.errors.badArchive') })
      } else {
        setNotice({ tone: 'error', text: serverMessage(r.body) ?? t('import.errors.startFailed') })
      }
    } catch (err) {
      if (!(err instanceof SessionExpired)) setNotice({ tone: 'error', text: t('import.errors.startFailed') })
    } finally {
      setStarting(false)
    }
  }

  async function onCancel() {
    if (panel.kind !== 'running') return
    const jobId = panel.jobId
    setCancelling(true)
    setNotice(null)
    try {
      const r = await call(apiJobCancelPath(jobId), { method: 'POST' })
      let poll: PollResult
      if (r.status === 200) {
        // A foreign 200 body is transient: keep the running state, the poll picks up the outcome.
        if (!isJobView(r.body)) return
        poll = { status: 200, view: r.body }
      } else if (r.status === 404) poll = { status: 404 }
      else {
        setNotice({ tone: 'error', text: t('import.errors.cancelFailed') })
        return
      }
      if (poll.status === 404) clearStored(space)
      setPanel((prev) => (prev.kind === 'running' && prev.jobId === jobId ? nextState(prev, poll) : prev))
    } catch (err) {
      if (!(err instanceof SessionExpired)) setNotice({ tone: 'error', text: t('import.errors.cancelFailed') })
    } finally {
      setCancelling(false)
    }
  }

  function onNewRun() {
    clearStored(space)
    setNotice(null)
    // The file input is remounted empty; drop the file it no longer shows.
    setFile(null)
    setPanel({ kind: 'form' })
  }

  function downloadReport(view: JobView) {
    if (view.report === null) return
    const url = URL.createObjectURL(new Blob([view.report], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = reportFileName(view.kind)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const statusLabel = (status: string): string =>
    (messages.import.status as Record<string, string>)[status] ?? status
  /** Text for a phase without page events; null for `writing` (page counts tell
   *  the progress there) and for a phase this UI does not know. */
  const phaseLabel = (phase: string | null): string | null =>
    phase === null || phase === 'writing' ? null : ((messages.import.phase as Record<string, string>)[phase] ?? null)

  const noticeBlock = notice ? (
    <div className={`callout ${notice.tone} import-notice`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </div>
  ) : null

  if (panel.kind === 'running') {
    const view = panel.view
    const phaseText = view ? phaseLabel(view.phase) : null
    return (
      <section className="import-panel">
        {noticeBlock}
        <h2 className="import-heading">{t('import.running')}</h2>
        <progress className="import-progress" max={100} value={view ? progressPercent(view) : 0} />
        <p className="import-progress-text" aria-live="polite">
          {phaseText !== null
            ? phaseText
            : view && view.total > 0
              ? t('import.progress', { done: view.done, total: view.total })
              : t('import.progressUnknown')}
        </p>
        {view && view.events.length > 0 && <EventList view={view} label={t('import.eventsLabel')} statusLabel={statusLabel} />}
        <div className="btn-row">
          <button type="button" className="btn danger" onClick={onCancel} disabled={cancelling}>
            {cancelling ? t('import.cancelling') : t('import.cancel')}
          </button>
        </div>
      </section>
    )
  }

  if (panel.kind === 'finished') {
    const view = panel.view
    const countEntries = Object.entries(view.counts)
    const finishedKey =
      view.status === 'failed'
        ? 'import.finished.failed'
        : view.status === 'cancelled'
          ? 'import.finished.cancelled'
          : 'import.finished.done'
    const waiting = waitingReviews(view.events)
    return (
      <section className="import-panel">
        {noticeBlock}
        <h2 className="import-heading">{t(finishedKey)}</h2>
        {countEntries.length > 0 && (
          <ul className="import-counts" aria-label={t('import.countsLabel')}>
            {countEntries.map(([key, n]) => (
              <li key={key}>
                <b>{n}</b> {statusLabel(key)}
              </li>
            ))}
          </ul>
        )}
        {waiting > 0 && (
          <p className="callout info import-notice">
            {t('import.waitingReviews', { count: waiting })} <a href={wikiReviewsHref(space)}>{t('import.waitingReviewsLink')}</a>
          </p>
        )}
        {view.events.length > 0 && <EventList view={view} label={t('import.eventsLabel')} statusLabel={statusLabel} />}
        {view.report !== null && (
          <>
            <h3 className="import-subheading">{t('import.reportLabel')}</h3>
            <pre className="import-report" tabIndex={0}>
              {view.report}
            </pre>
          </>
        )}
        <div className="btn-row">
          {view.kind === 'export-file' && view.status === 'done' && (
            <a className="btn primary" href={apiJobFilePath(view.id)} download>
              {t('import.downloadFile')}
            </a>
          )}
          {view.report !== null && (
            <button type="button" className="btn" onClick={() => downloadReport(view)}>
              {t('import.download')}
            </button>
          )}
          <button type="button" className="btn primary" onClick={onNewRun}>
            {t('import.newRun')}
          </button>
        </div>
      </section>
    )
  }

  return (
    <form className="import-panel" onSubmit={onStart} noValidate>
      {(hasBookstack || office) && (
        <div className="segmented import-tabs" role="group" aria-label={t('import.tabsLabel')}>
          <button type="button" aria-pressed={tab === 'import'} onClick={() => setTab('import')}>
            {t('import.tabs.import')}
          </button>
          <button type="button" aria-pressed={tab === 'export'} onClick={() => setTab('export')}>
            {t('import.tabs.export')}
          </button>
        </div>
      )}
      {tab === 'import' && hasBookstack && hasFile && (
        <div className="segmented import-tabs" role="group" aria-label={t('import.originLabel')}>
          <button type="button" aria-pressed={origin === 'bookstack'} onClick={() => switchOrigin('bookstack')}>
            {t('import.origins.bookstack')}
          </button>
          <button type="button" aria-pressed={origin === 'file'} onClick={() => switchOrigin('file')}>
            {t('import.origins.file')}
          </button>
        </div>
      )}

      {tab === 'export' && hasBookstack && office && (
        <div className="segmented import-tabs" role="group" aria-label={t('import.exportTargetLabel')}>
          <button type="button" aria-pressed={exportTarget === 'bookstack'} onClick={() => setExportTarget('bookstack')}>
            {t('import.exportTargets.bookstack')}
          </button>
          <button type="button" aria-pressed={exportTarget === 'file'} onClick={() => setExportTarget('file')}>
            {t('import.exportTargets.file')}
          </button>
        </div>
      )}

      {!isFileImport && !isFileExport && (
        <>
          <div className="field">
            <label className="label" htmlFor={id('instance')}>
              {t('import.instance')}
            </label>
            <div className="selectwrap">
              <select
                id={id('instance')}
                className="select"
                value={instance}
                onChange={(e) => {
                  setInstance(e.target.value)
                  setCatalog(null)
                }}
              >
                {instances.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <span className="caret" aria-hidden="true">
                ▾
              </span>
            </div>
          </div>

          <div className="import-row">
            <div className="field">
              <label className="label" htmlFor={id('token-id')}>
                {t('import.tokenId')}
              </label>
              <input
                id={id('token-id')}
                className="input"
                autoComplete="off"
                spellCheck={false}
                value={tokenId}
                onChange={(e) => setTokenId(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={id('token-secret')}>
                {t('import.tokenSecret')}
              </label>
              <input
                id={id('token-secret')}
                className="input"
                type="password"
                autoComplete="off"
                value={tokenSecret}
                onChange={(e) => setTokenSecret(e.target.value)}
              />
            </div>
          </div>
          <p className="import-hint">{t('import.tokenHint')}</p>
        </>
      )}

      {tab === 'import' ? (
        <>
          {isFileImport ? (
            <>
              <div className="field">
                <label className="label" htmlFor={id('file-format')}>
                  {t('import.fileFormat')}
                </label>
                <div className="selectwrap">
                  <select
                    id={id('file-format')}
                    className="select"
                    value={fileFormat}
                    onChange={(e) => {
                      setFileFormat(e.target.value as FileFormat)
                      setFile(null)
                    }}
                  >
                    <option value="markdown">{t('import.fileFormats.markdown')}</option>
                    <option value="obsidian">{t('import.fileFormats.obsidian')}</option>
                    <option value="html">{t('import.fileFormats.html')}</option>
                    {office && <option value="office">{t('import.fileFormats.office')}</option>}
                  </select>
                  <span className="caret" aria-hidden="true">
                    ▾
                  </span>
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor={id('file')}>
                  {t(fileFormat === 'office' ? 'import.fileOffice' : 'import.file')}
                </label>
                <input
                  // Remounted per format so a file chosen for another format is dropped.
                  key={fileFormat}
                  id={id('file')}
                  className="input"
                  type="file"
                  accept={fileAccept(fileFormat)}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {maxUploadMb !== null && (
                  <span className="hint">
                    {t(fileFormat === 'office' ? 'import.fileHintOffice' : 'import.fileHint', { max: maxUploadMb })}
                  </span>
                )}
              </div>
              {fileFormat === 'office' && (
                <label className="check">
                  <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                  <span>{t('import.splitOffice')}</span>
                </label>
              )}
              {fileFormat === 'office' && (
                <div role="group" aria-labelledby={id('word')}>
                  <span id={id('word')} className="label">
                    {t('import.word.legend')}
                  </span>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={word.numbering}
                      onChange={(e) => setWord({ ...word, numbering: e.target.checked })}
                    />
                    <span>{t('import.word.numbering')}</span>
                  </label>
                  <OptionSelect
                    inputId={id('word-main-name')}
                    label={t('import.word.mainName')}
                    value={word.mainName}
                    options={(['title', 'file', 'id'] as const).map((v) => [v, t(`import.word.mainNames.${v}`)])}
                    onChange={(v) => setWord({ ...word, mainName: v as WordFormOptions['mainName'] })}
                  />
                  {word.mainName === 'id' && (
                    <>
                      <div className="field">
                        <label className="label" htmlFor={id('word-id-pattern')}>
                          {t('import.word.idPattern')}
                        </label>
                        <input
                          id={id('word-id-pattern')}
                          className="input"
                          type="text"
                          maxLength={40}
                          placeholder="DOC-###"
                          value={word.idPattern}
                          onChange={(e) => setWord({ ...word, idPattern: e.target.value })}
                        />
                        <span className="hint">{t('import.word.idPatternHint')}</span>
                      </div>
                      <OptionSelect
                        inputId={id('word-id-display')}
                        label={t('import.word.idDisplay')}
                        value={word.idDisplay}
                        options={(['id', 'id-title'] as const).map((v) => [v, t(`import.word.idDisplays.${v}`)])}
                        onChange={(v) => setWord({ ...word, idDisplay: v as WordFormOptions['idDisplay'] })}
                      />
                    </>
                  )}
                  {split && (
                    <>
                      <OptionSelect
                        inputId={id('word-split-level')}
                        label={t('import.word.splitLevel')}
                        value={word.splitLevel}
                        options={LEVELS}
                        onChange={(v) => setWord({ ...word, splitLevel: v as WordFormOptions['splitLevel'] })}
                      />
                      <OptionSelect
                        inputId={id('word-sub-name')}
                        label={t('import.word.subName')}
                        value={word.subName}
                        options={(['chapter', 'title-chapter', 'key-chapter', 'key-number'] as const).map((v) => [
                          v,
                          t(`import.word.subNames.${v}`),
                        ])}
                        onChange={(v) => setWord({ ...word, subName: v as WordFormOptions['subName'] })}
                      />
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={word.toc}
                          onChange={(e) => setWord({ ...word, toc: e.target.checked })}
                        />
                        <span>{t('import.word.toc')}</span>
                      </label>
                      {word.toc && (
                        <OptionSelect
                          inputId={id('word-toc-depth')}
                          label={t('import.word.tocDepth')}
                          value={word.tocDepth}
                          options={LEVELS}
                          onChange={(v) => setWord({ ...word, tocDepth: v as WordFormOptions['tocDepth'] })}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="import-row">
                <div className="field">
                  <label className="label" htmlFor={id('source-kind')}>
                    {t('import.sourceKind')}
                  </label>
                  <div className="selectwrap">
                    <select
                      id={id('source-kind')}
                      className="select"
                      value={sourceKind}
                      onChange={(e) => {
                        setSourceKind(e.target.value as SourceKind)
                        setSourceValue('')
                      }}
                    >
                      <option value="book">{t('import.sourceKinds.book')}</option>
                      <option value="shelf">{t('import.sourceKinds.shelf')}</option>
                      <option value="page">{t('import.sourceKinds.page')}</option>
                    </select>
                    <span className="caret" aria-hidden="true">
                      ▾
                    </span>
                  </div>
                </div>
                <SourceField
                  inputId={id('source')}
                  kind={sourceKind}
                  catalog={catalog}
                  value={sourceValue}
                  onChange={setSourceValue}
                />
              </div>
              {sourceKind !== 'page' && (
                <div className="import-catalog">
                  <button type="button" className="btn small" onClick={loadCatalog} disabled={!credentialsReady || catalogBusy}>
                    {catalogBusy ? t('import.loadingBooks') : t('import.loadBooks')}
                  </button>
                  {catalog === null && <span className="import-hint">{t('import.catalogHint')}</span>}
                </div>
              )}
              {catalogError && (
                <div className="callout error import-notice" role="alert">
                  {catalogError}
                </div>
              )}
            </>
          )}

          <div className="field">
            <label className="label" htmlFor={id('parent')}>
              {t('import.parentId')}
            </label>
            <input
              id={id('parent')}
              className="input"
              autoComplete="off"
              spellCheck={false}
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            />
            <span className="hint">{t('import.parentIdHint')}</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
            <span>{t('import.update')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
            <span>{t('import.release')}</span>
          </label>
        </>
      ) : isFileExport ? (
        <>
          <div className="field">
            <label className="label" htmlFor={id('export-page')}>
              {t('import.exportFileStartPage')}
            </label>
            <input
              id={id('export-page')}
              className="input"
              autoComplete="off"
              spellCheck={false}
              value={startPageId}
              onChange={(e) => setStartPageId(e.target.value)}
            />
            <span className="hint">{t('import.exportFileStartPageHint')}</span>
          </div>
          <div className="field">
            <label className="label" htmlFor={id('export-format')}>
              {t('import.exportFormatLabel')}
            </label>
            <div className="selectwrap">
              <select
                id={id('export-format')}
                className="select"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`import.exportFormats.${f}`)}
                  </option>
                ))}
              </select>
              <span className="caret" aria-hidden="true">
                ▾
              </span>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={exportSubpages} onChange={(e) => setExportSubpages(e.target.checked)} />
            <span>{t('import.exportSubpages')}</span>
          </label>
        </>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor={id('start-page')}>
              {t('import.startPageId')}
            </label>
            <input
              id={id('start-page')}
              className="input"
              autoComplete="off"
              spellCheck={false}
              value={startPageId}
              onChange={(e) => setStartPageId(e.target.value)}
            />
            <span className="hint">{t('import.startPageIdHint')}</span>
          </div>
          <div className="field">
            <label className="label" htmlFor={id('book-id')}>
              {t('import.bookId')}
            </label>
            <input
              id={id('book-id')}
              className="input"
              inputMode="numeric"
              autoComplete="off"
              value={bookId}
              onChange={(e) => setBookId(e.target.value)}
            />
            <span className="hint">{t('import.bookIdHint')}</span>
          </div>
        </>
      )}
      {!isFileExport && (
        <label className="check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>{t('import.dryRun')}</span>
        </label>
      )}

      {noticeBlock}
      <div className="btn-row">
        <button type="submit" className="btn primary" disabled={starting}>
          {starting ? t('import.starting') : t('import.start')}
        </button>
      </div>
    </form>
  )
}

interface SourceFieldProps {
  inputId: string
  kind: SourceKind
  catalog: Catalog | null
  value: string
  onChange: (value: string) => void
}

/** The source of an import: a picker once the catalog is loaded, a text
 *  field before (or for a single page, a numeric id field). */
function SourceField({ inputId, kind, catalog, value, onChange }: SourceFieldProps) {
  const { t } = useT()
  const label =
    kind === 'book' ? t('import.bookSlug') : kind === 'shelf' ? t('import.shelfId') : t('import.pageId')

  const options =
    catalog && kind === 'book'
      ? catalog.books.map((b) => ({ value: b.slug, label: b.name }))
      : catalog && kind === 'shelf'
        ? catalog.shelves.map((s) => ({ value: String(s.id), label: s.name }))
        : null

  return (
    <div className="field">
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      {options ? (
        <div className="selectwrap">
          <select id={inputId} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('import.sourceChoose')}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="caret" aria-hidden="true">
            ▾
          </span>
        </div>
      ) : (
        <input
          id={inputId}
          className="input"
          autoComplete="off"
          spellCheck={false}
          inputMode={kind === 'page' ? 'numeric' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

interface EventListProps {
  view: JobView
  label: string
  statusLabel: (status: string) => string
}

/** Per-page events of a job (the API keeps the last 200). Pages link to
 *  where they can be seen now (see {@link eventHref}). */
function EventList({ view, label, statusLabel }: EventListProps) {
  return (
    <ol className="import-events" aria-label={label}>
      {view.events.map((e, i) => {
        const href = eventHref(view.space, e)
        return (
        <li key={i}>
          <span className="chip neutral">{statusLabel(e.status)}</span>{' '}
          {href ? <a href={href}>{e.title}</a> : <span>{e.title}</span>}
          {e.reason && <span className="import-event-reason"> — {e.reason}</span>}
        </li>
        )
      })}
    </ol>
  )
}
