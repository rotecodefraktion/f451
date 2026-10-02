'use client'

import { useT } from '../../lib/i18n/provider'
import type { JumpTarget } from '../../lib/theme-editor-view'

export type ActionStatus = { kind: 'ok'; text: string } | { kind: 'error'; text: string; items: string[] }

export interface StatusBarProps {
  errors: number
  warnings: number
  jump: { error: JumpTarget | null; warning: JumpTarget | null }
  onJump: (target: JumpTarget) => void
  /** parse errors without a row (template, brand, unknown keys) */
  fileProblems: string[]
  canWrite: boolean
  saveBlocked: boolean
  hasFile: boolean
  busy: 'save' | 'remove' | null
  onSave: () => void
  onRemove: () => void
  status: ActionStatus | null
}

/**
 * Header bar above the groups: error and warning counts, each with a jump to
 * its first row, and the actions with the server's answer next to them.
 */
export function StatusBar(props: StatusBarProps) {
  const { t } = useT()
  const { errors, warnings, jump, onJump, status, busy } = props

  return (
    <div className="te-bar" role="region" aria-label={t('settings.appearance.heading')}>
      <div className="te-bar-counts">
        <span className={errors > 0 ? 'chip error' : 'chip neutral'}>
          {t('settings.appearance.summaryErrors', { count: errors })}
        </span>
        <span className={warnings > 0 ? 'chip warn' : 'chip neutral'}>
          {t('settings.appearance.summaryWarnings', { count: warnings })}
        </span>
        {jump.error ? (
          <button type="button" className="btn small quiet" onClick={() => onJump(jump.error!)}>
            {t('settings.appearance.jumpError')}
          </button>
        ) : null}
        {jump.warning ? (
          <button type="button" className="btn small quiet" onClick={() => onJump(jump.warning!)}>
            {t('settings.appearance.jumpWarning')}
          </button>
        ) : null}
      </div>
      {props.fileProblems.length > 0 ? (
        <ul className="te-messages">
          {props.fileProblems.map((m) => (
            <li key={m}>{t('settings.appearance.fileProblem', { message: m })}</li>
          ))}
        </ul>
      ) : null}
      <div className="te-bar-actions">
        <button
          type="button"
          className="btn primary"
          disabled={props.saveBlocked || !props.canWrite || busy !== null}
          onClick={props.onSave}
        >
          {busy === 'save' ? t('settings.appearance.saving') : t('settings.appearance.save')}
        </button>
        {props.hasFile && props.canWrite ? (
          <button type="button" className="btn danger" disabled={busy !== null} onClick={props.onRemove}>
            {busy === 'remove' ? t('settings.appearance.removing') : t('settings.appearance.removeTheme')}
          </button>
        ) : null}
        {props.saveBlocked && props.canWrite ? <span className="te-bar-note">{t('settings.appearance.saveBlocked')}</span> : null}
        {status ? (
          <div className={status.kind === 'ok' ? 'te-bar-status' : 'te-bar-status te-bar-status-error'} role="status">
            <span>{status.text}</span>
            {status.kind === 'error' && status.items.length > 0 ? (
              <ul className="te-messages">
                {status.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
