'use client'

import type { ThemeFile, TokenGroup } from '@f451/design-tokens'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { istVorschau, leseUeberschreibungen } from '../../lib/erscheinungsbild'
import { useT } from '../../lib/i18n/provider'
import { overrideNames, PREVIEW_STORAGE_KEY, type PreviewOverrides } from '../../lib/theme-preview'
import {
  adoptTemplate,
  assess,
  buildGroups,
  fieldCheck,
  groupOpenDefaults,
  resetGroup,
  setBrandName,
  setUse,
  setValue,
  type EditorData,
  type EditorRow,
  type LibraryEntry,
  type RowFinding,
  type ValueMode,
} from '../../lib/theme-editor'
import {
  describeSaveFailure,
  firstRows,
  libraryApiPath,
  overridesToThemeFile,
  rowId,
  scopeParam,
  serverWarningCount,
  themeApiPath,
  tokenStates,
  USER_THEME_PATH,
  type JumpTarget,
  type SaveFailure,
  type ThemeScopes,
} from '../../lib/theme-editor-view'
import { BrandStrip } from './brand-strip'
import { ComponentPreview } from './component-preview'
import { endProgramPreview, ProgramPreview } from './program-preview'
import { ScopeSelector } from './scope-selector'
import { StatusBar, type ActionStatus } from './status-bar'
import { TemplateSelect } from './template-select'
import { GroupSection } from './token-group'
import { fieldKey } from './token-row'

/** Open state of the groups across visits (spec "Gliederung": "der Zustand wird gemerkt"). */
const OPEN_KEY = 'theme-editor-groups'

export interface ThemeEditorProps {
  scopes: ThemeScopes
  data: EditorData
  /** slot for the "Prüfschärfe" strip — between scope selector and the first group; the page leaves it out for the user scope */
  thresholdStrip?: ReactNode
  /** the scope's template library (`GET …/theme/library`); `null` when it could not be loaded */
  templates: LibraryEntry[] | null
}

/**
 * The theme editor of `/einstellungen/erscheinungsbild` (July spec, chapter
 * "Bedienung"). Holds the draft file of one scope; every value, origin and
 * contrast figure is recomputed from it through `lib/theme-editor.ts`, the
 * same checks the server runs on save. The page itself keeps the saved theme —
 * the draft never touches the document's style.
 */
export function ThemeEditor({ scopes, data, thresholdStrip, templates }: ThemeEditorProps) {
  // Program preview (whole app, localStorage) — ends on save or remove (July spec, "Vorschau").
  const [previewActive, setPreviewActive] = useState(false)
  const { t, locale } = useT()
  const router = useRouter()

  const [source, setSource] = useState(data)
  const [draft, setDraft] = useState<ThemeFile>(data.file ?? {})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [overriding, setOverriding] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<Record<TokenGroup, boolean>>(groupOpenDefaults)
  const [jump, setJump] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'remove' | 'import' | null>(null)
  const [status, setStatus] = useState<ActionStatus | null>(null)
  const isUser = data.scope.kind === 'user'
  const isSpace = data.scope.kind === 'space'
  const fileInput = useRef<HTMLInputElement>(null)
  // Old browser overrides offered for takeover (addendum §2); checked once per page load.
  const [takeover, setTakeover] = useState<PreviewOverrides | null>(null)
  const takeoverChecked = useRef(false)

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

  // The library is refetched here after a template write — a `router.refresh()`
  // would hand in new `data` and so throw the draft away.
  const [librarySource, setLibrarySource] = useState(templates)
  const [library, setLibrary] = useState(templates)
  if (librarySource !== templates) {
    setLibrarySource(templates)
    setLibrary(templates)
  }

  async function reloadLibrary() {
    try {
      const res = await fetch(libraryApiPath(data.scope), { credentials: 'same-origin' })
      if (!res.ok) return
      const body = (await res.json()) as { templates?: unknown }
      if (Array.isArray(body.templates)) setLibrary(body.templates as LibraryEntry[])
    } catch {
      /* keep the list we have — the write itself succeeded */
    }
  }

  const libraryEntries = useMemo(() => library ?? [], [library])
  const groups = useMemo(() => buildGroups(data, draft, libraryEntries), [data, draft, libraryEntries])
  const assessment = useMemo(() => assess(data, draft, libraryEntries), [data, draft, libraryEntries])
  const states = useMemo(() => tokenStates(assessment), [assessment])
  const jumpTargets = useMemo(() => firstRows(groups, states), [groups, states])
  // Unsaved edits — a brand upload refreshes the page and would drop them, so it asks first.
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data.file ?? {}), [draft, data.file])

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

  // Takeover from localStorage: an unmarked value (not a running program preview)
  // with at least one token is an old override set — ask once whether to keep it.
  useEffect(() => {
    if (!isUser || takeoverChecked.current) return
    takeoverChecked.current = true
    try {
      const raw = localStorage.getItem(PREVIEW_STORAGE_KEY)
      if (raw === null || istVorschau(raw)) return
      const overrides = leseUeberschreibungen(raw)
      if (overrideNames(overrides).some((name) => name.startsWith('--'))) setTakeover(overrides)
    } catch {
      /* blocked storage — nothing to take over */
    }
  }, [isUser])

  /** Yes: the old overrides become the personal theme; No: they are dropped. Either way the key goes. */
  async function answerTakeover(accept: boolean) {
    if (!takeover) return
    if (!accept) {
      endProgramPreview()
      setTakeover(null)
      return
    }
    setBusy('save')
    setStatus(null)
    try {
      const res = await fetch(USER_THEME_PATH, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overridesToThemeFile(takeover)),
      })
      if (res.ok) {
        // Removes the key and the values the no-flash script put on <html>.
        endProgramPreview()
        setTakeover(null)
        setStatus({ kind: 'ok', text: t('settings.appearance.user.takeover.done') })
        router.refresh()
        return
      }
      let failure: unknown = null
      try {
        failure = await res.json()
      } catch {
        failure = null
      }
      setStatus(failureStatus(describeSaveFailure(res.status, failure)))
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
    } finally {
      setBusy(null)
    }
  }

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

  /**
   * One write of the scope's theme: the draft as JSON (`save`), an uploaded
   * YAML file (`import`, user scope only) or `DELETE` (`remove`).
   */
  async function send(kind: 'save' | 'remove' | 'import', yaml?: string) {
    setBusy(kind)
    setStatus(null)
    try {
      const body =
        kind === 'save'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) }
          : kind === 'import'
            ? { headers: { 'content-type': 'application/yaml' }, body: yaml ?? '' }
            : {}
      const res = await fetch(themeApiPath(data.scope), {
        method: kind === 'remove' ? 'DELETE' : 'PUT',
        credentials: 'same-origin',
        ...body,
      })
      if (res.ok) {
        if (previewActive) {
          endProgramPreview()
          setPreviewActive(false)
        }
        setStatus({ kind: 'ok', text: await successText(kind, res) })
        // Refetch the editor data so origins and the "file exists" state follow the commit.
        router.refresh()
        return
      }
      let failure: unknown = null
      try {
        failure = await res.json()
      } catch {
        failure = null
      }
      setStatus(failureStatus(describeSaveFailure(res.status, failure)))
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
    } finally {
      setBusy(null)
    }
  }

  /** The ok text; a personal theme saved below the thresholds names the count as a quiet note. */
  async function successText(kind: 'save' | 'remove' | 'import', res: Response): Promise<string> {
    if (kind === 'remove') {
      return t(
        isUser ? 'settings.appearance.user.removed' : isSpace ? 'settings.appearance.space.removed' : 'settings.appearance.removed',
      )
    }
    const saved = t(kind === 'import' ? 'settings.appearance.user.imported' : 'settings.appearance.saved')
    if (!isUser) return saved
    let count = 0
    try {
      count = serverWarningCount(await res.json())
    } catch {
      count = 0
    }
    return count > 0 ? `${saved} ${t('settings.appearance.user.savedWarnings', { count })}` : saved
  }

  function remove() {
    const question = t(
      isUser
        ? 'settings.appearance.user.removeConfirm'
        : isSpace
          ? 'settings.appearance.space.removeConfirm'
          : 'settings.appearance.removeConfirm',
    )
    if (!window.confirm(question)) return
    void send('remove')
  }

  /** "Herunterladen": the stored personal theme as `theme.yaml`. */
  async function download() {
    setStatus(null)
    try {
      const res = await fetch(`${USER_THEME_PATH}?format=yaml`, { credentials: 'same-origin' })
      if (!res.ok) {
        setStatus(failureStatus({ kind: 'error' }))
        return
      }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = 'theme.yaml'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
    }
  }

  /** "Datei einlesen": the chosen YAML file replaces the personal theme (server validates). */
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    // Clear the input so choosing the same file again fires `change` again.
    input.value = ''
    if (!file) return
    let text: string
    try {
      text = await file.text()
    } catch {
      setStatus(failureStatus({ kind: 'error' }))
      return
    }
    await send('import', text)
  }

  return (
    <div className="theme-editor has-preview">
      <div className="theme-editor-main">
        <ScopeSelector scopes={scopes} current={data.scope} />
        {data.canWrite ? null : <p className="callout info te-readonly">{t('settings.appearance.readOnlyNote')}</p>}
        {isUser && takeover ? (
          <div className="callout info" role="status">
            <span>{t('settings.appearance.user.takeover.question')}</span>
            <div className="btn-row">
              <button
                type="button"
                className="btn small primary"
                disabled={busy !== null}
                onClick={() => void answerTakeover(true)}
              >
                {t('settings.appearance.user.takeover.yes')}
              </button>
              <button type="button" className="btn small quiet" disabled={busy !== null} onClick={() => void answerTakeover(false)}>
                {t('settings.appearance.user.takeover.no')}
              </button>
            </div>
          </div>
        ) : null}
        {thresholdStrip ?? null}
        {isSpace && data.file !== null ? <p className="te-template-note">{t('settings.appearance.space.ownTheme')}</p> : null}
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
          removeLabel={
            isUser ? t('settings.appearance.user.remove') : isSpace ? t('settings.appearance.space.remove') : undefined
          }
          status={status}
        />
        {isUser ? (
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void download()}>
              {t('settings.appearance.user.download')}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
              {busy === 'import' ? t('settings.appearance.user.importing') : t('settings.appearance.user.import')}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml"
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => void importFile(event)}
            />
          </div>
        ) : null}
        <TemplateSelect
          key={scopeParam(data.scope)}
          scope={data.scope}
          canWrite={data.canWrite}
          templates={library}
          use={draft.use}
          current={assessment.template}
          draft={draft}
          busy={busy !== null}
          onUse={(use) => setDraft((d) => setUse(d, use))}
          onAdopt={() => setDraft((d) => (assessment.template ? adoptTemplate(d, assessment.template) : d))}
          onLibraryChanged={reloadLibrary}
        />
        {/* "Marke" (addendum §7): instance and space only. Rendered here, not
            passed in as a slot like the threshold strip, because the name is
            part of the draft this component holds. */}
        {isUser ? null : (
          <BrandStrip
            key={`brand-${scopeParam(data.scope)}`}
            scope={data.scope}
            file={data.file}
            name={draft.brand?.name ?? ''}
            canWrite={data.canWrite}
            busy={busy !== null}
            dirty={dirty}
            resolved={assessment.resolved}
            onName={(name) => setDraft((d) => setBrandName(d, name))}
          />
        )}
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
      <aside className="theme-editor-preview">
        <ComponentPreview resolved={assessment.resolved} />
        <ProgramPreview resolved={assessment.resolved} active={previewActive} onChange={setPreviewActive} />
      </aside>
    </div>
  )
}
