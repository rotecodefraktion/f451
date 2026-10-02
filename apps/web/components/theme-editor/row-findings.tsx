'use client'

import type { ContrastThresholds } from '@f451/design-tokens'
import { useT } from '../../lib/i18n/provider'
import type { RowFinding } from '../../lib/theme-editor'
import { thresholdField } from '../../lib/theme-editor-view'

export interface RowFindingsProps {
  findings: RowFinding[]
  /** the instance defaults — a warning names them when the threshold was lowered below */
  defaults: ContrastThresholds
}

/**
 * The contrast pairs of one token in one mode, each in one of the three
 * states of the spec ("Rückmeldung an der Zeile"): met, warning (above the
 * configured threshold, below AA — saving stays possible) and rejection
 * (below the threshold — saving is blocked). Both non-ok texts name the role,
 * because the same ratio means different things per role.
 */
export function RowFindings({ findings, defaults }: RowFindingsProps) {
  const { t, locale } = useT()
  if (findings.length === 0) return null
  const ratio = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 })

  return (
    <ul className="te-findings">
      {findings.map((f) => {
        const field = thresholdField(f.role)
        const role = t(`settings.appearance.contrastRole.${field}`)
        const params = {
          ratio: ratio(f.ratio),
          what: f.what,
          threshold: ratio(f.threshold),
          aa: ratio(f.aa),
          role,
          default: ratio(defaults[field]),
        }
        const text =
          f.state === 'ok'
            ? t('settings.appearance.contrastOk', params)
            : f.state === 'error'
              ? t('settings.appearance.contrastError', params)
              : f.ratio < f.threshold
                ? // below the threshold yet only a warning: the user scope (`assess`)
                  t('settings.appearance.contrastWarningPersonal', params)
                : f.threshold < defaults[field]
                ? t('settings.appearance.contrastWarningLowered', params)
                : t('settings.appearance.contrastWarning', params)
        return (
          <li
            key={`${f.against}|${f.what}`}
            className={
              f.state === 'error'
                ? 'te-finding te-finding-error'
                : f.state === 'warning'
                  ? 'te-finding te-finding-warning'
                  : 'te-finding te-finding-ok'
            }
          >
            {text}
          </li>
        )
      })}
    </ul>
  )
}
