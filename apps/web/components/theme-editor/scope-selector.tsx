'use client'

import { useRouter } from 'next/navigation'
import { useT } from '../../lib/i18n/provider'
import { scopeParam, type ScopeKey, type ThemeScopes } from '../../lib/theme-editor-view'

const PAGE = '/einstellungen/erscheinungsbild'

export interface ScopeSelectorProps {
  scopes: ThemeScopes
  current: ScopeKey
}

/**
 * Which theme file the page edits — the instance or one readable space. A
 * change navigates (`?scope=`), so the server component loads that scope's
 * data. Scopes without write right stay selectable: one may look at what
 * applies.
 */
export function ScopeSelector({ scopes, current }: ScopeSelectorProps) {
  const { t } = useT()
  const router = useRouter()

  const entries: { value: string; label: string }[] = []
  if (scopes.instance.available) {
    const label = t('settings.appearance.scopeInstance')
    entries.push({
      value: 'instance',
      label: scopes.instance.canWrite ? label : t('settings.appearance.scopeReadOnly', { label }),
    })
  }
  for (const space of scopes.spaces) {
    const label = t('settings.appearance.scopeSpace', { name: space.name })
    entries.push({
      value: scopeParam({ kind: 'space', id: space.id }),
      label: space.canWrite ? label : t('settings.appearance.scopeReadOnly', { label }),
    })
  }

  return (
    <div className="field te-scope">
      <label className="label" htmlFor="te-scope">
        {t('settings.appearance.scopeLabel')}
      </label>
      <div className="selectwrap">
        <select
          id="te-scope"
          className="select"
          value={scopeParam(current)}
          onChange={(event) => router.push(`${PAGE}?scope=${encodeURIComponent(event.target.value)}`)}
        >
          {entries.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
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
