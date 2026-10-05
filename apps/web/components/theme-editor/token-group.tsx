'use client'

import { useT } from '../../lib/i18n/provider'
import type { EditorGroup } from '../../lib/theme-editor'
import type { TokenStates } from '../../lib/theme-editor-view'
import { TokenRow, type TokenRowProps } from './token-row'

type SharedRowProps = Omit<TokenRowProps, 'row' | 'messages' | 'state' | 'overriding'>

export interface GroupSectionProps extends SharedRowProps {
  group: EditorGroup
  open: boolean
  onToggle: (open: boolean) => void
  onResetGroup: () => void
  states: TokenStates
  /** rule and parse messages by token */
  messages: ReadonlyMap<string, string[]>
  overriding: ReadonlySet<string>
}

/** One catalog group as a collapsible section; the heading carries the number of values set here. */
export function GroupSection({
  group,
  open,
  onToggle,
  onResetGroup,
  states,
  messages,
  overriding,
  ...rowProps
}: GroupSectionProps) {
  const { t } = useT()
  return (
    <details className="card te-group" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary className="te-group-head">
        <h2>{group.group}</h2>
        {group.setCount > 0 ? (
          <span className="chip neutral te-origin-set">
            {t('settings.appearance.groupSetCount', { count: group.setCount })}
          </span>
        ) : null}
      </summary>
      {group.group === 'Rahmen' ? <p className="te-template-note">{t('settings.appearance.frameGroupNote')}</p> : null}
      <div className="te-group-tools">
        <button
          type="button"
          className="btn small"
          disabled={group.setCount === 0 || !rowProps.canWrite}
          onClick={onResetGroup}
        >
          {t('settings.appearance.resetGroup')}
        </button>
      </div>
      {group.rows.map((row) => (
        <TokenRow
          key={row.name}
          row={row}
          messages={messages.get(row.name) ?? []}
          state={states.errors.has(row.name) ? 'error' : states.warnings.has(row.name) ? 'warning' : null}
          overriding={overriding.has(row.name)}
          {...rowProps}
        />
      ))}
    </details>
  )
}
