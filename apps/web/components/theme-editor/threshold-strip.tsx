'use client'

import type { ContrastFinding, ContrastThresholds, LayerSource } from '@f451/design-tokens'
import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../../lib/i18n/provider'
import type { EditorData } from '../../lib/theme-editor'
import { thresholdField } from '../../lib/theme-editor-view'

/**
 * The "Prüfschärfe" strip above the first token group (July spec, chapter
 * "Kontrast", sections "Prüfschärfe einstellen", "Damit die Absenkung nicht in
 * Vergessenheit gerät", "Wortlaut des Info-Knopfes"; chapter "Bedienung",
 * "Gliederung").
 *
 * Shows the four instance-wide thresholds next to their fixed AA reference,
 * the number of findings below AA on the scope's saved, resolved set, the
 * info text and the report "Werte unter AA". In the instance scope with push
 * right the thresholds are editable (`PUT`/`DELETE /api/theme/contrast`).
 *
 * Not here (yet):
 *  - date and author of the last threshold change: the spec takes them from the
 *    Git commit of `_meta/contrast.yaml`, and neither `EditorData` nor the
 *    contrast route carries them.
 *  - the per-space line of the report (count of below-AA findings per readable
 *    space): it needs `GET /api/theme/contrast/spaces`, which does not exist.
 */

export interface ThresholdStripProps {
  data: EditorData
  /** push right on the instance repo — only then the instance scope edits */
  canWriteInstance: boolean
  scopeKind: 'instance' | 'space'
}

type Field = keyof ContrastThresholds

const FIELDS: readonly Field[] = ['readingText', 'shortText', 'nonText', 'incidental']
const MIN = 1.5
const MAX = 7.0

type Inputs = Record<Field, string>
type Status = { kind: 'ok' | 'error'; text: string }

const toInputs = (t: ContrastThresholds): Inputs =>
  Object.fromEntries(FIELDS.map((f) => [f, String(t[f])])) as Inputs

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isField = (v: unknown): v is Field => typeof v === 'string' && (FIELDS as readonly string[]).includes(v)

/** `**bold**` and `` `code` `` inside one line of the info text — rendered as text, never as markup. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    return part
  })
}

/** Body of an info section: blank line = paragraph, "- " lines = list, "1. " lines = numbered list. */
function infoBody(body: string): ReactNode[] {
  return body.split(/\n\s*\n/).map((block, i) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length > 0 && lines.every((l) => l.startsWith('- '))) {
      return (
        <ul key={i}>
          {lines.map((l, j) => (
            <li key={j}>{inline(l.slice(2))}</li>
          ))}
        </ul>
      )
    }
    if (lines.length > 0 && lines.every((l) => /^\d+\. /.test(l))) {
      return (
        <ol key={i}>
          {lines.map((l, j) => (
            <li key={j}>{inline(l.replace(/^\d+\. /, ''))}</li>
          ))}
        </ol>
      )
    }
    return <p key={i}>{inline(lines.join(' '))}</p>
  })
}

export function ThresholdStrip({ data, canWriteInstance, scopeKind }: ThresholdStripProps) {
  const { t, locale, messages } = useT()
  const router = useRouter()
  const m = messages.settings.appearance

  const [source, setSource] = useState(data)
  const [inputs, setInputs] = useState<Inputs>(() => toInputs(data.thresholds))
  const [note, setNote] = useState(data.note ?? '')
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [copyStatus, setCopyStatus] = useState<Status | null>(null)

  // New data (refresh after a save, or another scope): start over from it.
  if (source !== data) {
    setSource(data)
    setInputs(toInputs(data.thresholds))
    setNote(data.note ?? '')
  }

  // One decimal for thresholds (the file's precision); measured ratios keep two,
  // because the comparison uses the value rounded to two (spec "Rundung").
  const { fmt1, fmt2 } = useMemo(
    () => ({
      fmt1: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      fmt2: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    }),
    [locale],
  )
  const one = (n: number) => fmt1.format(n)
  const two = (n: number) => fmt2.format(n)

  const roleName = (f: Field): string => m.contrastRole[f]
  const editable = scopeKind === 'instance' && canWriteInstance
  const lowered = FIELDS.some((f) => data.thresholds[f] < data.defaults[f])
  // Fixed at mount: a controlled `open` would collapse the block (and the reset message with it) once a reset lifts the lowering.
  const initialOpen = useRef(lowered).current
  const belowAA = useMemo(() => data.findings.filter((f) => f.belowAA), [data.findings])

  // ---- Report rows ----------------------------------------------------------

  function originLabel(layer: LayerSource): string {
    if (layer === 'default') return m.originDefault
    if (layer === 'instance') return scopeKind === 'instance' ? m.originSet : m.threshold.originInstance
    return m.originSet
  }

  function originOf(finding: ContrastFinding, ref: string): { name: string; label: string } {
    const name = ref.replace('~', '')
    const origins = data.resolved.origin[finding.mode] as Record<string, { source: LayerSource } | undefined>
    return { name: name.replace(/^--/, ''), label: originLabel(origins[name]?.source ?? 'default') }
  }

  const rows = belowAA.map((f) => {
    const field = thresholdField(f.role)
    const fg = originOf(f, f.pair.vorn)
    const bg = originOf(f, f.pair.hinten)
    return {
      mode: f.mode === 'light' ? m.modeLight : m.modeDark,
      ratio: `${two(f.ratio)}:1`,
      aa: `${one(data.aa[field])}:1`,
      threshold: `${one(f.threshold)}:1`,
      role: roleName(field),
      pair: f.pair.was,
      origin: t('settings.appearance.threshold.originPair', {
        fg: fg.name,
        fgOrigin: fg.label,
        bg: bg.name,
        bgOrigin: bg.label,
      }),
    }
  })

  async function copyTable() {
    const head = [
      m.threshold.colMode,
      m.threshold.colRatio,
      m.threshold.colAA,
      m.threshold.colThreshold,
      m.threshold.colRole,
      m.threshold.colPair,
      m.threshold.colOrigin,
    ]
    const body = rows.map((r) => [r.mode, r.ratio, r.aa, r.threshold, r.role, r.pair, r.origin])
    const text = [head, ...body].map((cells) => cells.map((c) => c.replace(/[\t\n]/g, ' ')).join('\t')).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus({ kind: 'ok', text: m.threshold.copied })
    } catch {
      setCopyStatus({ kind: 'error', text: m.threshold.copyFailed })
    }
  }

  // ---- Writing --------------------------------------------------------------

  function failureText(httpStatus: number, body: unknown, sent: ContrastThresholds | null): string {
    if (httpStatus === 404) return m.threshold.errorNotConfigured
    if (httpStatus === 409) return m.threshold.errorConflict
    if (httpStatus === 403) {
      return isRecord(body) && body.action === 'connect' ? m.threshold.errorConnect : m.threshold.errorForbidden
    }
    if (httpStatus === 422 && isRecord(body)) {
      const code = body.error
      const key = body.key
      const role = isField(key) ? roleName(key) : ''
      if (code === 'threshold_out_of_range') {
        const min = typeof body.min === 'number' ? body.min : MIN
        const max = typeof body.max === 'number' ? body.max : MAX
        if (isField(key) && sent && sent[key] < min) return m.threshold.errorOff
        return t('settings.appearance.threshold.errorRange', { role, min: one(min), max: one(max) })
      }
      if (code === 'threshold_precision') return t('settings.appearance.threshold.errorPrecision', { role })
      if (code === 'threshold_not_a_number') return t('settings.appearance.threshold.errorNumber', { role })
      if (code === 'threshold_order') return m.threshold.errorOrder
      if (code === 'note_invalid') return m.threshold.errorNote
      if (typeof body.message === 'string') return t('settings.appearance.threshold.errorInvalid', { message: body.message })
    }
    return m.threshold.errorGeneric
  }

  /** The four inputs as numbers, or a message for the first one that is not a number. */
  function parsedInputs(): { ok: true; values: ContrastThresholds } | { ok: false; text: string } {
    const values = {} as ContrastThresholds
    for (const f of FIELDS) {
      const raw = inputs[f].trim()
      const n = raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(n)) return { ok: false, text: t('settings.appearance.threshold.errorNumber', { role: roleName(f) }) }
      values[f] = n
    }
    return { ok: true, values }
  }

  async function send(kind: 'save' | 'reset') {
    let sent: ContrastThresholds | null = null
    if (kind === 'save') {
      const parsed = parsedInputs()
      if (!parsed.ok) {
        setStatus({ kind: 'error', text: parsed.text })
        return
      }
      sent = parsed.values
    } else if (!window.confirm(m.threshold.resetConfirm)) {
      return
    }
    setBusy(kind)
    setStatus(null)
    try {
      const res = await fetch('/api/theme/contrast', {
        method: kind === 'save' ? 'PUT' : 'DELETE',
        credentials: 'same-origin',
        ...(kind === 'save'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...sent, note }) }
          : {}),
      })
      if (res.ok) {
        setStatus({ kind: 'ok', text: kind === 'save' ? m.threshold.saved : m.threshold.resetDone })
        router.refresh()
        return
      }
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      setStatus({ kind: 'error', text: failureText(res.status, body, sent) })
    } catch {
      setStatus({ kind: 'error', text: m.threshold.errorGeneric })
    } finally {
      setBusy(null)
    }
  }

  // ---- Render ---------------------------------------------------------------

  const summary = FIELDS.map((f) =>
    t(
      data.thresholds[f] < data.aa[f] ? 'settings.appearance.threshold.roleBelowAA' : 'settings.appearance.threshold.roleAtAA',
      { role: roleName(f), value: one(data.thresholds[f]), aa: one(data.aa[f]) },
    ),
  ).join(', ')

  const info = m.thresholdInfo
  const infoSections = [info.why, info.who, info.legal, info.defaults, info.meetAA]
  const aaInfo = m.threshold.aaInfo

  return (
    // Collapsed by default so the template select and token groups below stay in
    // view; open at mount when thresholds are lowered below the defaults.
    <details
      className={lowered ? 'te-threshold te-threshold-lowered' : 'te-threshold'}
      aria-label={m.threshold.heading}
      open={initialOpen}
    >
      <summary className="te-threshold-head">
        <strong>{m.threshold.heading}:</strong> {summary}
        {' · '}
        {t('settings.appearance.threshold.belowAACount', { count: belowAA.length })}
      </summary>
      <div className="te-threshold-body">
        {lowered ? (
          <p className="te-threshold-note">
            {m.threshold.lowered}
            {data.note ? (
              <>
                {' '}
                <strong>{m.threshold.noteLabel}</strong> {data.note}
              </>
            ) : null}
          </p>
        ) : null}

        {editable ? (
          <form
            className="te-threshold-form"
            onSubmit={(e) => {
              e.preventDefault()
              void send('save')
            }}
          >
            <div className="te-threshold-fields">
              {FIELDS.map((f) => (
                <label key={f} className="te-threshold-field">
                  <span className="te-threshold-label">
                    {t('settings.appearance.threshold.fieldLabel', {
                      role: roleName(f),
                      default: one(data.defaults[f]),
                      aa: one(data.aa[f]),
                    })}
                  </span>
                  <input
                    className="input te-number"
                    type="number"
                    inputMode="decimal"
                    step={0.1}
                    min={MIN}
                    max={MAX}
                    value={inputs[f]}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const value = e.target.value
                      setInputs((prev) => ({ ...prev, [f]: value }))
                    }}
                  />
                </label>
              ))}
            </div>
            <label className="te-threshold-field">
              <span className="te-threshold-label">{m.threshold.noteFieldLabel}</span>
              <textarea
                className="input te-threshold-notefield"
                maxLength={500}
                rows={2}
                value={note}
                disabled={busy !== null}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <div className="te-threshold-actions">
              <button type="submit" className="btn primary" disabled={busy !== null}>
                {busy === 'save' ? m.threshold.saving : m.threshold.save}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy !== null || data.thresholdsSource === 'default'}
                onClick={() => void send('reset')}
              >
                {busy === 'reset' ? m.threshold.resetting : m.threshold.reset}
              </button>
            </div>
          </form>
        ) : (
          <p className="te-threshold-readonly">
            {scopeKind === 'instance' ? m.threshold.readOnlyInstance : m.threshold.readOnlySpace}
          </p>
        )}
        {status ? (
          <p
            className={status.kind === 'error' ? 'te-threshold-status te-threshold-status-error' : 'te-threshold-status'}
            role={status.kind === 'error' ? 'alert' : 'status'}
          >
            {status.text}
          </p>
        ) : null}

        <details className="te-threshold-info">
          <summary className="te-threshold-summary">
            <span className="te-threshold-i" aria-hidden="true">
              i
            </span>
            {m.threshold.infoToggle}
          </summary>
          <div className="te-threshold-info-body">
            {infoSections.map((s) => (
              <div key={s.heading}>
                <h3>{s.heading}</h3>
                {infoBody(s.body)}
              </div>
            ))}
          </div>
        </details>

        <details className="te-threshold-info">
          <summary className="te-threshold-summary">
            <span className="te-threshold-i" aria-hidden="true">
              i
            </span>
            {aaInfo.title}
          </summary>
          <div className="te-threshold-info-body">
            {[aaInfo.what, aaInfo.levels, aaInfo.howF451, aaInfo.twoSteps, aaInfo.report, aaInfo.guide].map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </details>

        <details className="te-threshold-report">
          <summary className="te-threshold-summary">
            {m.threshold.reportToggle} ({belowAA.length})
          </summary>
          {rows.length === 0 ? (
            <p className="te-threshold-empty">{m.threshold.reportEmpty}</p>
          ) : (
            <>
              <div className="te-threshold-table-wrap">
                <table className="te-threshold-table">
                  <thead>
                    <tr>
                      <th scope="col">{m.threshold.colMode}</th>
                      <th scope="col">{m.threshold.colRatio}</th>
                      <th scope="col">{m.threshold.colAA}</th>
                      <th scope="col">{m.threshold.colThreshold}</th>
                      <th scope="col">{m.threshold.colRole}</th>
                      <th scope="col">{m.threshold.colPair}</th>
                      <th scope="col">{m.threshold.colOrigin}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.mode}</td>
                        <td>{r.ratio}</td>
                        <td>{r.aa}</td>
                        <td>{r.threshold}</td>
                        <td>{r.role}</td>
                        <td>{r.pair}</td>
                        <td>{r.origin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="te-threshold-actions">
                <button type="button" className="btn small" onClick={() => void copyTable()}>
                  {m.threshold.copyTable}
                </button>
                {copyStatus ? (
                  <span
                    className={
                      copyStatus.kind === 'error' ? 'te-threshold-status te-threshold-status-error' : 'te-threshold-status'
                    }
                    role="status"
                  >
                    {copyStatus.text}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </details>
      </div>
    </details>
  )
}
