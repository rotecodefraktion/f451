'use client'

import { useEffect, useState } from 'react'
import {
  ClientApiError,
  deleteTemplate,
  getTemplate,
  listTemplates,
  renameTemplate,
  updateTemplate,
  type TemplateSummary,
} from '../../lib/editor/client-api'
import { useT } from '../../lib/i18n/provider'
import type { T } from '../../lib/i18n/types'

export interface TemplatesManagerProps {
  space: string
  /** Ausgangsstand (`GET /api/spaces/:space/templates`, server-seitig von
   *  `templates/page.tsx` geladen, Muster `MetadataSchemaEditor`). */
  initialTemplates: TemplateSummary[]
}

/** Welches Inline-Panel (falls eines) unter einer Vorlagenzeile offen ist —
 *  IMMER höchstens eines gleichzeitig, über die ganze Liste hinweg (Muster
 *  `metadata-panel.tsx`s auf-/zuklappbare Karte: einfacher als ein
 *  Panel-Zustand pro Zeile, für diese Seite ausreichend). */
type OpenPanel = { id: string; kind: 'rename' } | { id: string; kind: 'content' } | null

type RenameState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }

type ContentLoadState = { status: 'loading' } | { status: 'loaded' } | { status: 'load-error'; message: string }

type ContentSaveState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

/** Generische Fehlermeldung für einen unerwarteten `ClientApiError` (Netzwerk/
 *  502/…) — Muster `NewPageButton`s `catch`-Zweig: nur dokumentierte
 *  Vertragsfälle (400/403/404/409) bekommen die präzise Server-Meldung.
 *  `action` ist bereits übersetzt (z. B. `t('templates.errors.renameFailed')`). */
function genericErrorMessage(t: T, action: string): string {
  return t('templates.errors.retry', { action })
}

/**
 * „Umbenennen"-Panel (Name + Beschreibung) einer Space-Vorlage. Bei
 * Namensänderung mit anderem Datei-Slug benennt der Server die Datei um —
 * die `id` der Vorlage kann sich dadurch ändern, daher lädt der Aufrufer nach
 * Erfolg die gesamte Liste neu ({@link listTemplates}) statt die Zeile nur
 * lokal zu patchen (s. {@link TemplatesManager#onRenameSaved}).
 */
function RenamePanel({
  space,
  template,
  onSaved,
  onCancel,
}: {
  space: string
  template: TemplateSummary
  onSaved: () => void
  onCancel: () => void
}) {
  const { t } = useT()
  const [name, setName] = useState(template.name)
  const [description, setDescription] = useState(template.description)
  const [state, setState] = useState<RenameState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmedName = name.trim()
    if (trimmedName.length === 0) return

    setState({ status: 'submitting' })
    try {
      const result = await renameTemplate(space, template.id, { name: trimmedName, description })
      if (result.ok) {
        onSaved()
        return
      }
      setState({ status: 'error', message: result.error })
    } catch (err) {
      if (err instanceof ClientApiError) {
        setState({ status: 'error', message: genericErrorMessage(t, t('templates.errors.renameFailed')) })
      }
    }
  }

  return (
    <form className="tpl-panel" onSubmit={onSubmit}>
      <label>
        {t('templates.name')}
        <input
          type="text"
          className="mf-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoComplete="off"
        />
      </label>
      <label>
        {t('templates.description')}
        <input
          type="text"
          className="mf-input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          autoComplete="off"
        />
      </label>
      {/* `.tpl-panel` ist eine Flex-Spalte mit `gap` — der Hinweisblock
          braucht deshalb keinen eigenen Außenabstand (und keinen
          Inline-Stil, der einen fremden zurücknimmt). */}
      {state.status === 'error' ? (
        <p className="callout error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="tpl-panel-actions">
        <button type="button" className="btn small" onClick={onCancel}>
          {t('templates.cancel')}
        </button>
        <button type="submit" className="btn primary small" disabled={state.status === 'submitting'}>
          {state.status === 'submitting' ? t('templates.saving') : t('templates.save')}
        </button>
      </div>
    </form>
  )
}

/**
 * „Inhalt bearbeiten"-Panel einer Space-Vorlage — Roh-Markdown in einer
 * Textarea (Vorlagen sind Rohtext, KEIN WYSIWYG nötig, s. Aufgabenstellung).
 * Lädt den aktuellen Inhalt beim Öffnen NACH (`getTemplate`, `GET
 * .../templates/:id`) — die Zusammenfassung aus `listTemplates` enthält
 * keinen Body.
 */
function ContentPanel({
  space,
  template,
  onSaved,
  onCancel,
}: {
  space: string
  template: TemplateSummary
  onSaved: () => void
  onCancel: () => void
}) {
  const { t } = useT()
  const [load, setLoad] = useState<ContentLoadState>({ status: 'loading' })
  const [content, setContent] = useState('')
  const [save, setSave] = useState<ContentSaveState>({ status: 'idle' })

  // Beim Öffnen einmalig laden (die Zusammenfassung aus `listTemplates`
  // enthält keinen Body) — `ignore` schützt vor einer veralteten Antwort,
  // falls das Panel vor Abschluss des Fetches wieder geschlossen wird
  // (Muster `NewPageButton`s Vorlagen-Fetch).
  useEffect(() => {
    let ignore = false
    getTemplate(space, template.id)
      .then((result) => {
        if (ignore) return
        if (result.ok) {
          setContent(result.template.body)
          setLoad({ status: 'loaded' })
        } else {
          setLoad({ status: 'load-error', message: result.error })
        }
      })
      .catch(() => {
        if (!ignore) {
          setLoad({ status: 'load-error', message: genericErrorMessage(t, t('templates.errors.contentLoadFailed')) })
        }
      })
    return () => {
      ignore = true
    }
  }, [space, template.id])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSave({ status: 'submitting' })
    try {
      const result = await updateTemplate(space, template.id, content)
      if (result.ok) {
        onSaved()
        return
      }
      setSave({ status: 'error', message: result.error })
    } catch (err) {
      if (err instanceof ClientApiError) {
        setSave({ status: 'error', message: genericErrorMessage(t, t('templates.errors.contentSaveFailed')) })
      }
    }
  }

  if (load.status === 'loading') {
    // Ladezustand-Baustein (43-flaeche.css). Das Skelett ist Dekoration und
    // steht deshalb mit `aria-hidden` außerhalb des Zugänglichkeitsbaums;
    // die Meldung „lädt" trägt die Live-Region daneben (Spec „Zugesicherte
    // Eigenschaften", Punkt 2 — nichts visuell Verborgenes per display:none).
    return (
      <div className="tpl-panel">
        <div className="skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <p className="hint" role="status">
          {t('templates.contentLoading')}
        </p>
      </div>
    )
  }
  if (load.status === 'load-error') {
    return (
      <div className="tpl-panel">
        <p className="callout error" role="alert">
          {load.message}
        </p>
        <div className="tpl-panel-actions">
          <button type="button" className="btn small" onClick={onCancel}>
            {t('templates.close')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <form className="tpl-panel" onSubmit={onSubmit}>
      <label>
        {t('templates.contentLabel')}
        <textarea
          className="mf-input schema-field-textarea tpl-content-textarea"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={16}
          spellCheck={false}
        />
      </label>
      {save.status === 'error' ? (
        <p className="callout error" role="alert">
          {save.message}
        </p>
      ) : null}
      <div className="tpl-panel-actions">
        <button type="button" className="btn small" onClick={onCancel}>
          {t('templates.cancel')}
        </button>
        <button type="submit" className="btn primary small" disabled={save.status === 'submitting'}>
          {save.status === 'submitting' ? t('templates.saving') : t('templates.save')}
        </button>
      </div>
    </form>
  )
}

/**
 * Vorlagen-Pflege (Werkzeuge-Bereich „Vorlagen") — pflegt `_templates/*.md`
 * eines Space. Space-Vorlagen: Umbenennen (Name + Beschreibung), Inhalt
 * bearbeiten (Roh-Markdown), Löschen (mit `window.confirm`, Muster
 * `status-bar.tsx#handleDeletePageClick`). Globale Vorlagen sind reine
 * Anzeige (Badge „global", keine Aktionen) — der Server lehnt einen Schreib-
 * versuch ohnehin mit 403 ab, die UI blendet die Aktionen dafür erst gar
 * nicht ein (kein irreführender Button, der immer fehlschlägt).
 *
 * Erster-Run-Entscheidung (Muster `MetadataSchemaEditor`/`new-page-button.tsx`):
 * die Aktionen (Umbenennen/Bearbeiten/Löschen) sind für Space-Vorlagen IMMER
 * sichtbar, unabhängig vom Schreibrecht — ein Leser bekommt beim Absenden die
 * 403-Meldung im Panel statt vorab ausgeblendeter Buttons (der Server-Gate
 * ist die eigentliche Durchsetzung, eine zweite clientseitige Prüfung nur für
 * die Anzeige lohnt sich nicht).
 */
export function TemplatesManager({ space, initialTemplates }: TemplatesManagerProps) {
  const { t } = useT()
  const [templates, setTemplates] = useState(initialTemplates)
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function reload() {
    try {
      setTemplates(await listTemplates(space))
      setListError(null)
    } catch {
      setListError(t('templates.errors.reloadFailed'))
    }
  }

  function onPanelSaved() {
    setOpenPanel(null)
    void reload()
  }

  async function onDelete(template: TemplateSummary) {
    if (!window.confirm(t('templates.deleteConfirm', { name: template.name }))) {
      return
    }
    setDeletingId(template.id)
    try {
      const result = await deleteTemplate(space, template.id)
      if (result.ok) {
        setTemplates((current) => current.filter((t) => t.id !== template.id))
        setListError(null)
      } else {
        setListError(result.error)
      }
    } catch (err) {
      if (err instanceof ClientApiError) {
        setListError(genericErrorMessage(t, t('templates.errors.deleteFailed')))
      }
    } finally {
      setDeletingId(null)
    }
  }

  if (templates.length === 0) {
    // Leerzustand-Baustein (43-flaeche.css) statt einer grauen Textzeile.
    return (
      <div className="tpl-manager">
        <div className="empty">
          <p>{t('templates.empty')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="tpl-manager">
      {listError ? (
        <p className="callout error tool-status" role="alert">
          {listError}
        </p>
      ) : null}
      <ul className="tpl-list">
        {templates.map((template) => {
          const isGlobal = template.source === 'global'
          const panelOpenHere = openPanel?.id === template.id ? openPanel.kind : null
          // `tpl-row` ist mit seinem Innenabstand weggefallen — die Zeile ist
          // jetzt einfach eine Karte. Die Kinder behalten ihre
          // `tpl-row-*`-Namen, sie tragen eigene Regeln.
          return (
            <li key={template.id} className="card">
              <div className="tpl-row-head">
                <span className="tpl-row-name">
                  <b>{template.name}</b>
                  {isGlobal ? <span className="chip neutral">{t('templates.global')}</span> : null}
                </span>
                {template.description ? <small className="tpl-row-desc">{template.description}</small> : null}
                <span className="grow" />
                {isGlobal ? (
                  <span className="hint" style={{ margin: 0 }}>
                    {t('templates.readOnly')}
                  </span>
                ) : (
                  <div className="tpl-row-actions">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => setOpenPanel(panelOpenHere === 'rename' ? null : { id: template.id, kind: 'rename' })}
                    >
                      {t('templates.rename')}
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => setOpenPanel(panelOpenHere === 'content' ? null : { id: template.id, kind: 'content' })}
                    >
                      {t('templates.editContent')}
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => onDelete(template)}
                      disabled={deletingId === template.id}
                    >
                      {deletingId === template.id ? t('templates.deleting') : t('templates.delete')}
                    </button>
                  </div>
                )}
              </div>
              {panelOpenHere === 'rename' ? (
                <RenamePanel
                  space={space}
                  template={template}
                  onSaved={onPanelSaved}
                  onCancel={() => setOpenPanel(null)}
                />
              ) : null}
              {panelOpenHere === 'content' ? (
                <ContentPanel
                  space={space}
                  template={template}
                  onSaved={onPanelSaved}
                  onCancel={() => setOpenPanel(null)}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
