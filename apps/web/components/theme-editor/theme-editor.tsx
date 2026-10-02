'use client'

import type { ThemeFile, TokenGroup } from '@f451/design-tokens'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useT } from '../../lib/i18n/provider'
import {
  assess,
  buildGroups,
  fieldCheck,
  groupOpenDefaults,
  resetGroup,
  setValue,
  type EditorData,
  type EditorRow,
  type RowFinding,
  type ValueMode,
} from '../../lib/theme-editor'
import {
  describeSaveFailure,
  firstRows,
  rowId,
  themeApiPath,
  tokenStates,
  type JumpTarget,
  type SaveFailure,
  type ThemeScopes,
} from '../../lib/theme-editor-view'
import { ScopeSelector } from './scope-selector'
import { StatusBar, type ActionStatus } from './status-bar'
import { GroupSection } from './token-group'
import { fieldKey } from './token-row'

/** Open state of the groups across visits (spec "Gliederung": "der Zustand wird gemerkt"). */
const OPEN_KEY = 'theme-editor-groups'

export interface ThemeEditorProps {
  scopes: ThemeScopes
  data: EditorData
  /** slot for the "Prüfschärfe" strip — between scope selector and the first group */
  thresholdStrip?: ReactNode
  /** slot for the component preview — a right column */
  preview?: ReactNode
}

/**
 * The theme editor of `/einstellungen/erscheinungsbild` (July spec, chapter
 * "Bedienung"). Holds the draft file of one scope; every value, origin and
 * contrast figure is recomputed from it through `lib/theme-editor.ts`, the
 * same checks the server runs on save. The page itself keeps the saved theme —
 * the draft never touches the document's style.
 */
export function ThemeEditor({ scopes, data, thresholdStrip, preview }: ThemeEditorProps) {
  const { t, locale } = useT()
  const router = useRouter()

  const [source, setSource] = useState(data)
  const [draft, setDraft] = useState<ThemeFile>(data.file ?? {})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [overriding, setOverriding] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<Record<TokenGroup, boolean>>(groupOpenDefaults)
  const [jump, setJump] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [status, setStatus] = useState<ActionStatus | null>(null)

  // New data (another scope, or the refetch after a save): start over from its file.
  if (source !== data) {
    setSource(data)
    setDraft(data.file ?? {})
    setFieldErrors({})
    setOverriding(new Set())
    if (source.scope.kind !== data.scope.kind || (source.scope.kind === 'space' && data.scope.kind === 'space' && source.scope.id !== data.scope.id)) {
      setStatus(null)
    }
  }

  const groups = useMemo(() => buildGroups(data, draft), [data, draft])
  const assessment = useMemo(() => assess(data, draft), [data, draft])
  const states = useMemo(() => tokenStates(assessment), [assessment])
  const jumpTargets = useMemo(() => firstRows(groups, states), [groups, states])

  const findings = useMemo(() => {
    const map = new Map<string, RowFinding[]>()
    for (const f of assessment.findings) {
      const key = fieldKey(f.token, f.mode)
      map.set(key, [...(map.get(key) ?? []), f])
    }
    return map
  }, [assessment])

  const { messages, fileProblems } = useMemo(() => {
    const byToken = new Map<string, string[]>()
    const add = (token: string, text: string) => byToken.set(token, [...(byToken.get(token) ?? []), text])
    const loose: string[] = []
    for (const r of assessment.rules) {
      const text = t('settings.appearance.ruleViolation', { rule: r.rule, message: r.message })
      for (const token of r.tokens) add(token, text)
    }
    for (const p of assessment.problems) {
      if (p.token && groups.some((g) => g.rows.some((row) => row.name === p.token))) add(p.token, p.message)
      else loose.push(p.message)
    }
    return { messages: byToken, fileProblems: loose }
  }, [assessment, groups, t])

  // Remembered open state; storage may be blocked — then the defaults apply.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(OPEN_KEY)
      if (!raw) return
      const saved: unknown = JSON.parse(raw)
      if (saved && typeof saved === 'object') {
        setOpen((prev) => {
          const next = { ...prev }
          for (const g of Object.keys(prev) as TokenGroup[]) {
            const v = (saved as Record<string, unknown>)[g]
            if (typeof v === 'boolean') next[g] = v
          }
          return next
        })
      }
    } catch {
      /* unreadable or blocked storage — keep the defaults */
    }
  }, [])

  function toggleGroup(group: TokenGroup, isOpen: boolean) {
    setOpen((prev) => {
      if (prev[group] === isOpen) return prev
      const next = { ...prev, [group]: isOpen }
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next))
      } catch {
        /* blocked storage — the state holds for this visit */
      }
      return next
    })
  }

  // A jump opens the group first; the row exists only after that render.
  useEffect(() => {
    if (!jump) return
    const el = document.getElementById(rowId(jump))
    el?.scrollIntoView({ block: 'center' })
    setJump(null)
  }, [jump, open])

  function jumpTo(target: JumpTarget) {
    toggleGroup(target.group, true)
    setJump(target.token)
  }

  function change(token: string, mode: ValueMode, value: string) {
    setDraft((d) => setValue(d, token, mode, value))
  }

  function blur(token: string, mode: ValueMode) {
    const v = draft[mode]?.[token.replace(/^--/, '')]
    const key = fieldKey(token, mode)
    // Only an own value is checked — an inherited one is not this file's business.
    const check = v === undefined ? null : fieldCheck(token, v)
    setFieldErrors((prev) => {
      const next = { ...prev }
      if (check && !check.ok) next[key] = check.reason
      else delete next[key]
      return next
    })
  }

  function resetRow(row: EditorRow) {
    setDraft((d) => {
      let next = d
      for (const mode of Object.keys(row.values) as ValueMode[]) next = setValue(next, row.name, mode, null)
      return next
    })
    setFieldErrors((prev) => {
      const next = { ...prev }
      for (const mode of Object.keys(row.values) as ValueMode[]) delete next[fieldKey(row.name, mode)]
      return next
    })
    setOverriding((prev) => {
      const next = new Set(prev)
      next.delete(row.name)
      return next
    })
  }

  function override(token: string) {
    setOverriding((prev) => new Set(prev).add(token))
  }

  function resetWholeGroup(group: TokenGroup) {
    setDraft((d) => resetGroup(d, group))
    const tokens = new Set<string>(groups.find((g) => g.group === group)?.rows.map((r) => r.name) ?? [])
    setFieldErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !tokens.has(key.split('|')[0]!))))
    setOverriding((prev) => new Set([...prev].filter((n) => !tokens.has(n))))
  }

  const ratio = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 })

  function failureStatus(failure: SaveFailure): ActionStatus {
    switch (failure.kind) {
      case 'invalid':
        return { kind: 'error', text: t('settings.appearance.serverInvalid'), items: failure.messages }
      case 'contrast':
        return {
          kind: 'error',
          text: t('settings.appearance.serverContrast'),
          items: failure.items.map((i) =>
            t('settings.appearance.serverContrastItem', {
              what: i.what,
              mode: i.mode === 'light' ? t('settings.appearance.modeLight') : t('settings.appearance.modeDark'),
              ratio: ratio(i.ratio),
              threshold: ratio(i.threshold),
            }),
          ),
        }
      case 'forbidden':
        return { kind: 'error', text: t('settings.appearance.serverForbidden'), items: [] }
      case 'conflict':
        return { kind: 'error', text: t('settings.appearance.serverConflict'), items: [] }
      case 'notFound':
        return { kind: 'error', text: t('settings.appearance.serverNotFound'), items: [] }
      case 'error':
        return { kind: 'error', text: t('settings.appearance.serverError'), items: [] }
    }
  }

  async function send(kind: 'save' | 'remove') {
    setBusy(kind)
    setStatus(null)
    try {
      const res = await fetch(themeApiPath(data.scope), {
        method: kind === 'save' ? 'PUT' : 'DELETE',
        credentials: 'same-origin',
        ...(kind === 'save' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) } : {}),
      })
      if (res.ok) {
        setStatus({ kind: 'ok', text: t(kind === 'save' ? 'settings.appearance.saved' : 'settings.appearance.removed') })
        // Refetch the editor data so origins and the "file exists" state follow the commit.
        router.refresh()
        return
      }
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      setStatus(failureStatus(describeSaveFailure(res.status, body)))
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
    } finally {
      setBusy(null)
    }
  }

  function remove() {
    if (!window.confirm(t('settings.appearance.removeConfirm'))) return
    void send('remove')
  }

  return (
    <div className={preview ? 'theme-editor has-preview' : 'theme-editor'}>
      <div className="theme-editor-main">
        <ScopeSelector scopes={scopes} current={data.scope} />
        {data.canWrite ? null : <p className="callout info te-readonly">{t('settings.appearance.readOnlyNote')}</p>}
        {thresholdStrip ?? null}
        <StatusBar
          errors={assessment.errors}
          warnings={assessment.warnings}
          jump={jumpTargets}
          onJump={jumpTo}
          fileProblems={fileProblems}
          canWrite={data.canWrite}
          saveBlocked={assessment.saveBlocked}
          hasFile={data.file !== null}
          busy={busy}
          onSave={() => void send('save')}
          onRemove={remove}
          status={status}
        />
        {groups.map((group) => (
          <GroupSection
            key={group.group}
            group={group}
            open={open[group.group] ?? false}
            onToggle={(isOpen) => toggleGroup(group.group, isOpen)}
            onResetGroup={() => resetWholeGroup(group.group)}
            states={states}
            messages={messages}
            overriding={overriding}
            canWrite={data.canWrite}
            findings={findings}
            defaults={data.defaults}
            fieldErrors={fieldErrors}
            onChange={change}
            onBlur={blur}
            onReset={resetRow}
            onOverride={override}
          />
        ))}
      </div>
      {preview ? <aside className="theme-editor-preview">{preview}</aside> : null}
    </div>
  )
}
