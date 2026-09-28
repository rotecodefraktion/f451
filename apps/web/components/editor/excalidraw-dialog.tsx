'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { loadDiagram, saveDiagram } from '../../lib/editor/client-api'
import { sceneFromSvgText, sceneToSvgText } from '../../lib/editor/excalidraw-io'
import type { DiagramDialogState } from './wysiwyg-editor'
import { useT } from '../../lib/i18n/provider'

const Excalidraw = dynamic(async () => (await import('@excalidraw/excalidraw')).Excalidraw, { ssr: false })

export interface ExcalidrawDialogProps {
  pageId: string
  state: DiagramDialogState
  onSaved: (state: DiagramDialogState) => void
  onClose: () => void
}

/** Eingebetteter Excalidraw-Editor (React-Komponente, kein externer Dienst).
 *  Speichern exportiert die Szene als SVG mit eingebetteter Quelle
 *  (exportEmbedScene) und committet sie über die Diagramm-Route (Task 2). */
export function ExcalidrawDialog({ pageId, state, onSaved, onClose }: ExcalidrawDialogProps) {
  const { t, locale } = useT()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [initialData, setInitialData] = useState<object | null>(state.isNew ? {} : null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    if (state.isNew) return
    let ignore = false
    loadDiagram(pageId, state.path)
      .then(sceneFromSvgText)
      .then((scene) => {
        if (!ignore) setInitialData(scene)
      })
      .catch(() => {
        if (!ignore) setError(t('editor.excalidrawDialog.loadFailed'))
      })
    return () => {
      ignore = true
    }
  }, [pageId, state.isNew, state.path])

  // Guard gegen Doppel-Submit (Klick/Enter während ein Save noch läuft) — der
  // Button ist zwar über `disabled={!api || saving}` bereits gesperrt, dieser
  // frühe Return im Handler selbst ist die zweite, vom DOM unabhängige
  // Absicherung (Muster wie `DrawioDialog#persist`, dort über den
  // `initial === null`-Guard vor dem iframe-Mount).
  const handleSave = useCallback(async () => {
    if (!api || saving) return
    setSaving(true)
    try {
      const svgText = await sceneToSvgText(api)
      const result = await saveDiagram(pageId, {
        path: state.path,
        content: svgText,
        ...(state.isNew ? { ifAbsent: true } : {}),
      })
      if (!result.ok) {
        setError(t('editor.excalidrawDialog.nameExists'))
        return
      }
      onSaved(state)
      onClose()
    } catch {
      setError(t('editor.excalidrawDialog.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [api, onClose, onSaved, pageId, saving, state, t])

  return (
    <dialog ref={dialogRef} className="diagram-dialog" onClose={onClose}>
      {error ? (
        <p className="diagram-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="diagram-canvas">
        {initialData !== null ? (
          <Excalidraw excalidrawAPI={setApi} initialData={initialData} langCode={locale === 'de' ? 'de-DE' : 'en'} />
        ) : (
          <p className="diagram-dialog-status">{t('editor.excalidrawDialog.loading')}</p>
        )}
      </div>
      <div className="diagram-dialog-actions">
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {t('editor.excalidrawDialog.cancel')}
        </button>
        <button type="button" className="btn primary" onClick={() => void handleSave()} disabled={!api || saving}>
          {saving ? t('editor.excalidrawDialog.saving') : t('editor.excalidrawDialog.saveAndClose')}
        </button>
      </div>
    </dialog>
  )
}
