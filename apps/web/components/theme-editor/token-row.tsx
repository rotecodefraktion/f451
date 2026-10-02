'use client'

import type { ContrastThresholds, Mode } from '@f451/design-tokens'
import type { ReactNode } from 'react'
import { useT } from '../../lib/i18n/provider'
import type { EditorRow, RowFinding, ValueMode, ValueOrigin } from '../../lib/theme-editor'
import { rowId } from '../../lib/theme-editor-view'
import { RowFindings } from './row-findings'
import { ColorField, StructureField, Swatch, TextField, fieldId } from './value-fields'

const COLOR_MODES: readonly Mode[] = ['light', 'dark']

export const fieldKey = (token: string, mode: ValueMode): string => `${token}|${mode}`

export interface TokenRowProps {
  row: EditorRow
  canWrite: boolean
  /** contrast findings by `fieldKey(token, mode)` */
  findings: ReadonlyMap<string, RowFinding[]>
  defaults: ContrastThresholds
  /** blur-check reasons by `fieldKey(token, mode)` */
  fieldErrors: Readonly<Record<string, string>>
  /** rule violations and parse errors naming this token */
  messages: string[]
  state: 'error' | 'warning' | null
  /** derived row switched to "übersteuern" without a value yet */
  overriding: boolean
  onChange: (token: string, mode: ValueMode, value: string) => void
  onBlur: (token: string, mode: ValueMode) => void
  onReset: (row: EditorRow) => void
  onOverride: (token: string) => void
}

function LockGlyph() {
  return (
    <svg className="te-lock" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" rx="1" fill="currentColor" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** One catalog token: name and origin, role, value field(s), reset, inline feedback. */
export function TokenRow(props: TokenRowProps) {
  const { row, canWrite, findings, defaults, fieldErrors, messages, state, overriding } = props
  const { t } = useT()
  const modes = Object.keys(row.values) as ValueMode[]
  const isSet = modes.some((m) => row.values[m]?.origin === 'set')
  const readOnly = !canWrite

  const modeName = (m: ValueMode) =>
    m === 'light' ? t('settings.appearance.modeLight') : m === 'dark' ? t('settings.appearance.modeDark') : ''
  const originName = (o: ValueOrigin) =>
    o === 'set'
      ? t('settings.appearance.originSet')
      : o === 'inherited'
        ? t('settings.appearance.originInherited')
        : t('settings.appearance.originDefault')

  // One mark when all modes agree, otherwise one per mode.
  const origins = modes.map((m) => ({ mode: m, origin: row.values[m]!.origin }))
  const uniform = origins.every((o) => o.origin === origins[0]?.origin)
  const marks = uniform
    ? origins.slice(0, 1).map((o) => ({ key: 'all', origin: o.origin, text: originName(o.origin) }))
    : origins.map((o) => ({
        key: o.mode,
        origin: o.origin,
        text: t('settings.appearance.originPerMode', { mode: modeName(o.mode), origin: originName(o.origin) }),
      }))

  const shown = (m: ValueMode) => {
    const v = row.values[m]!
    return v.set ?? v.effective
  }

  const fieldProps = (m: ValueMode) => ({
    token: row.name,
    mode: m,
    value: shown(m),
    invalid: fieldErrors[fieldKey(row.name, m)] !== undefined,
    readOnly,
    onChange: (value: string) => props.onChange(row.name, m, value),
    onBlur: () => props.onBlur(row.name, m),
  })

  /** One column per colour mode: label, field(s), blur error, contrast findings. */
  const modeColumns = (render: (m: Mode) => ReactNode, withField = true) => (
    <div className="te-modes">
      {COLOR_MODES.filter((m) => row.values[m]).map((m) => (
        <div className="te-mode" key={m}>
          {withField ? (
            <label className="te-mode-label" htmlFor={fieldId(row.name, m)}>
              {modeName(m)}
            </label>
          ) : (
            <span className="te-mode-label">{modeName(m)}</span>
          )}
          {render(m)}
          <FieldError reason={fieldErrors[fieldKey(row.name, m)]} />
          <RowFindings findings={findings.get(fieldKey(row.name, m)) ?? []} defaults={defaults} />
        </div>
      ))}
    </div>
  )

  let value: ReactNode
  if (row.locked) {
    value = (
      <div className="te-locked" aria-disabled="true">
        {modes.length > 0 ? (
          <span className="te-locked-value">
            {modes.map((m) => (m === 'base' ? shown(m) : `${modeName(m)}: ${shown(m)}`)).join(' · ')}
          </span>
        ) : null}
        <span className="te-lock-reason">
          <LockGlyph />
          {t('settings.appearance.lockedReason', { reason: row.lockReason ?? '' })}
        </span>
      </div>
    )
  } else if (row.kind === 'color' || (row.kind === 'derived' && (row.overridden || overriding))) {
    value = modeColumns((m) => <ColorField {...fieldProps(m)} />)
  } else if (row.kind === 'derived') {
    value = (
      <>
        <p className="te-formula">
          <span className="te-formula-label">{t('settings.appearance.formulaLabel')}</span>
          <code>{row.formula}</code>
        </p>
        {modeColumns((m) => (
          <span className="te-derived-value">
            <Swatch color={row.values[m]!.effective} />
            <code>{row.values[m]!.effective}</code>
          </span>
        ), false)}
      </>
    )
  } else if (row.kind === 'shadow') {
    value = modeColumns((m) => <TextField {...fieldProps(m)} />)
  } else if (row.kind === 'structure') {
    value = (
      <div className="te-base">
        <StructureField {...fieldProps('base')} range={row.range} />
        <FieldError reason={fieldErrors[fieldKey(row.name, 'base')]} />
      </div>
    )
  } else {
    value = null
  }

  // The state class is spelled out inside className so the CSS inventory finds
  // it; a locked row is marked by its inner `.te-locked` block, not by a class.
  return (
    <div
      className={state === 'error' ? 'te-row te-row-error' : state === 'warning' ? 'te-row te-row-warning' : 'te-row'}
      id={rowId(row.name)}
    >
      <div className="te-row-head">
        <code className="te-name">{row.name}</code>
        <span className="te-origins">
          {marks.map((m) => (
            <span key={m.key} className={m.origin === 'set' ? 'chip neutral te-origin-set' : 'chip neutral'}>
              {m.text}
            </span>
          ))}
        </span>
        <span className="te-role">{row.role}</span>
      </div>
      <div className="te-row-value">
        {value}
        {messages.length > 0 ? (
          <ul className="te-messages">
            {messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="te-row-actions">
        {row.kind === 'derived' && !row.locked && canWrite ? (
          row.overridden || overriding ? (
            <button type="button" className="btn small quiet" onClick={() => props.onReset(row)}>
              {t('settings.appearance.restoreDerivation')}
            </button>
          ) : (
            <button type="button" className="btn small quiet" onClick={() => props.onOverride(row.name)}>
              {t('settings.appearance.override')}
            </button>
          )
        ) : null}
        {row.locked || modes.length === 0 ? null : (
          <button
            type="button"
            className="btn small"
            disabled={!isSet || readOnly}
            aria-label={t('settings.appearance.resetRowLabel', { token: row.name })}
            onClick={() => props.onReset(row)}
          >
            {t('settings.appearance.resetRow')}
          </button>
        )}
      </div>
    </div>
  )
}

function FieldError({ reason }: { reason: string | undefined }) {
  const { t } = useT()
  if (reason === undefined) return null
  return (
    <p className="te-field-error" role="alert">
      {t('settings.appearance.fieldInvalid', { reason })}
    </p>
  )
}
