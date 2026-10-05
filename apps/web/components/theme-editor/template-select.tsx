'use client'

import type { ThemeFile } from '@f451/design-tokens'
import { useState, type FormEvent } from 'react'
import { useT } from '../../lib/i18n/provider'
import { templateFile, type EditorScope, type LibraryEntry, type TemplateState } from '../../lib/theme-editor'
import {
  describeSaveFailure,
  libraryApiPath,
  ownsTemplate,
  slugFromName,
  TEMPLATE_SLUG,
  templateOptions,
} from '../../lib/theme-editor-view'
import type { ActionStatus } from './status-bar'

export interface TemplateSelectProps {
  scope: EditorScope
  canWrite: boolean
  /** the scope's library; `null` when it could not be loaded */
  templates: readonly LibraryEntry[] | null
  /** the draft's `use` */
  use: string | undefined
  /** the entry the draft's `use` resolves to (`Assessment.template`) */
  current: LibraryEntry | null
  /** the draft — the body of "Als Vorlage speichern" */
  draft: ThemeFile
  /** a theme write is running */
  busy: boolean
  onUse: (use: string | null) => void
  /** which template applies here and underneath (`templateState`) */
  state: TemplateState
  /** copy the chosen template into the draft; `use` stays */
  onAdopt: () => void
  /** refetch the library after a template write */
  onLibraryChanged: () => Promise<void>
}

/**
 * "Vorlage" above the token table (addendum §3/§7): pick the template the
 * draft builds on (`use`), save the draft as a template of this scope, delete
 * an own template. Picking only changes the draft — it is saved with the theme.
 * Template writes go straight to the library routes and refetch the list.
 */
export function TemplateSelect(props: TemplateSelectProps) {
  const { scope, canWrite, templates, use, current, draft, busy, state, onUse, onLibraryChanged } = props
  const { t, locale } = useT()
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [working, setWorking] = useState(false)
  const [status, setStatus] = useState<ActionStatus | null>(null)

  const library = templates ?? []
  const options = templateOptions(scope.kind, library)
  const selected = current ? [...options.own, ...options.instance].find((o) => o.entry === current)?.value : undefined
  const unknownUse = use !== undefined && use !== '' && current === null ? use : null
  const value = selected ?? use ?? ''
  const removable = canWrite && current !== null && ownsTemplate(scope.kind, current)
  const canSaveAs = canWrite && scope.kind !== 'user'
  const slugBad = slug !== '' && !TEMPLATE_SLUG.test(slug)
  const disabled = busy || working

  const label = (entry: LibraryEntry) =>
    entry.origin === 'builtin' ? t('settings.appearance.template.builtin', { name: entry.name }) : entry.name
  const ratio = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 })

  const sourceLabel = (source: string) =>
    source === 'space' ? t('settings.appearance.template.sourceSpace') : t('settings.appearance.template.sourceInstance')
  function underneath(): string {
    const inherited = state.inherited
    switch (inherited.kind) {
      case 'template':
        return t('settings.appearance.template.underneathTemplate', { name: inherited.name, source: sourceLabel(inherited.source) })
      case 'custom':
        return t('settings.appearance.template.underneathCustom', { source: sourceLabel(inherited.source) })
      default:
        return t('settings.appearance.template.underneathDefault')
    }
  }
  const scopeNote =
    scope.kind === 'instance'
      ? state.own === 'none'
        ? t('settings.appearance.template.instanceDefault')
        : null
      : t('settings.appearance.template.underneath', { what: underneath() })

  async function failureOf(res: Response): Promise<ActionStatus> {
    // 405: a built-in slug on the instance routes — neither writable nor deletable.
    if (res.status === 405) return { kind: 'error', text: t('settings.appearance.template.serverBuiltin'), items: [] }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const failure = describeSaveFailure(res.status, body)
    switch (failure.kind) {
      case 'invalid':
        return { kind: 'error', text: t('settings.appearance.template.serverInvalid'), items: failure.messages }
      case 'contrast':
        return {
          kind: 'error',
          text: t('settings.appearance.template.serverContrast'),
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
        return { kind: 'error', text: t('settings.appearance.template.serverForbidden'), items: [] }
      case 'notFound':
        return { kind: 'error', text: t('settings.appearance.template.serverNotFound'), items: [] }
      default:
        return { kind: 'error', text: t('settings.appearance.serverError'), items: [] }
    }
  }

  function changeName(next: string) {
    setName(next)
    if (!slugTouched) setSlug(slugFromName(next))
  }

  function closeForm() {
    setFormOpen(false)
    setName('')
    setSlug('')
    setSlugTouched(false)
  }

  async function saveAs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '' || !TEMPLATE_SLUG.test(slug)) return
    const existing = library.some((e) => e.slug === slug && ownsTemplate(scope.kind, e))
    if (existing && !window.confirm(t('settings.appearance.template.overwriteConfirm', { slug }))) return
    setWorking(true)
    setStatus(null)
    try {
      const res = await fetch(libraryApiPath(scope, slug), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(templateFile(draft, trimmed, current)),
      })
      if (res.ok) {
        closeForm()
        setStatus({ kind: 'ok', text: t('settings.appearance.template.saved', { name: trimmed }) })
        await onLibraryChanged()
        return
      }
      setStatus(await failureOf(res))
    } catch {
      setStatus({ kind: 'error', text: t('settings.appearance.serverError'), items: [] })
    } finally {
      setWorking(false)
    }
  }

  async function remove(entry: LibraryEntry) {
    if (!window.confirm(t('settings.appearance.template.removeConfirm', { name: entry.name }))) return
    setWorking(true)
    setStatus(null)
    try {
      const res = await fetch(libraryApiPath(scope, entry.slug), { method: 'DELETE', credentials: 'same-origin' })
      if (res.ok) {
        setStatus({ kind: 'ok', text: t('settings.appearance.template.removed') })
        await onLibraryChanged()
        return
      }
      setStatus(await failureOf(res))
    } catch {
      setStatus({ kind: 'error', text: t('settings.appearance.serverError'), items: [] })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="te-template">
      <div className="field te-template-field">
        <label className="label" htmlFor="te-template">
          {t('settings.appearance.template.label')}
        </label>
        <div className="te-template-row">
          <div className="selectwrap te-template-select">
            <select
              id="te-template"
              className="select"
              value={value}
              disabled={!canWrite || disabled}
              onChange={(event) => onUse(event.target.value === '' ? null : event.target.value)}
            >
              <option value="">
                {state.own === 'custom'
                  ? t('settings.appearance.template.noneCustom')
                  : t('settings.appearance.template.none')}
              </option>
              {unknownUse !== null ? (
                <option value={unknownUse}>{t('settings.appearance.template.unknownOption', { use: unknownUse })}</option>
              ) : null}
              {options.own.length > 0 ? (
                <optgroup
                  label={
                    scope.kind === 'space'
                      ? t('settings.appearance.template.groupSpace')
                      : t('settings.appearance.template.groupInstance')
                  }
                >
                  {options.own.map((o) => (
                    <option key={o.value} value={o.value}>
                      {label(o.entry)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {options.instance.length > 0 ? (
                <optgroup label={t('settings.appearance.template.groupInstance')}>
                  {options.instance.map((o) => (
                    <option key={o.value} value={o.value}>
                      {label(o.entry)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            <span className="caret" aria-hidden="true">
              ▾
            </span>
          </div>
          {removable && current ? (
            <button
              type="button"
              className="btn small quiet"
              disabled={disabled}
              aria-label={t('settings.appearance.template.removeLabel', { name: current.name })}
              title={t('settings.appearance.template.removeLabel', { name: current.name })}
              onClick={() => void remove(current)}
            >
              {t('settings.appearance.template.remove')}
            </button>
          ) : null}
        </div>
      </div>
      {scopeNote !== null ? <p className="te-template-note">{scopeNote}</p> : null}
      {templates === null ? (
        <p className="te-template-note">{t('settings.appearance.template.loadError')}</p>
      ) : unknownUse !== null ? (
        <p className="te-template-note te-template-note-missing" role="status">
          {t('settings.appearance.template.notFound', { use: unknownUse })}
        </p>
      ) : null}
      {canWrite && !formOpen ? (
        <div className="btn-row">
          {canSaveAs ? (
            <button
              type="button"
              className="btn small"
              disabled={disabled}
              onClick={() => {
                setStatus(null)
                setFormOpen(true)
              }}
            >
              {t('settings.appearance.template.saveAs')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn small"
            disabled={disabled || !current}
            onClick={props.onAdopt}
            title={t('settings.appearance.template.adoptHint')}
          >
            {t('settings.appearance.template.adopt')}
          </button>
        </div>
      ) : null}
      {canSaveAs && formOpen ? (
        <form className="te-template-form" onSubmit={(event) => void saveAs(event)}>
          <p className="te-template-note">{t('settings.appearance.template.saveAsHint')}</p>
          <div className="te-template-fields">
            <div className="field te-template-input">
              <label className="label" htmlFor="te-template-name">
                {t('settings.appearance.template.nameLabel')}
              </label>
              <input
                id="te-template-name"
                className="input"
                value={name}
                autoComplete="off"
                onChange={(event) => changeName(event.target.value)}
              />
            </div>
            <div className="field te-template-input">
              <label className="label" htmlFor="te-template-slug">
                {t('settings.appearance.template.slugLabel')}
              </label>
              <input
                id="te-template-slug"
                className="input te-template-slug"
                value={slug}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={slugBad}
                aria-describedby="te-template-slug-hint"
                onChange={(event) => {
                  setSlugTouched(true)
                  setSlug(event.target.value)
                }}
              />
              <small id="te-template-slug-hint" className="te-template-note">
                {t('settings.appearance.template.slugHint')}
              </small>
              {slugBad ? (
                <p className="te-field-error" role="alert">
                  {t('settings.appearance.template.slugInvalid')}
                </p>
              ) : null}
            </div>
          </div>
          <div className="btn-row">
            <button
              type="submit"
              className="btn small primary"
              disabled={disabled || name.trim() === '' || !TEMPLATE_SLUG.test(slug)}
            >
              {working ? t('settings.appearance.template.saving') : t('settings.appearance.template.submit')}
            </button>
            <button type="button" className="btn small quiet" disabled={working} onClick={closeForm}>
              {t('settings.appearance.template.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      {status ? (
        <div
          className={status.kind === 'error' ? 'te-template-status te-template-status-error' : 'te-template-status'}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
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
  )
}
