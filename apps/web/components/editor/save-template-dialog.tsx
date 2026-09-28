'use client'

import { useEffect, useRef, useState } from 'react'
import type { SaveAsTemplateResult } from '../../lib/editor/client-api'
import { useT } from '../../lib/i18n/provider'

export interface SaveTemplateDialogProps {
  open: boolean
  /** Feuert bei JEDEM Schließen (Escape/Backdrop-Klick/„Abbrechen"/„Schließen"
   *  nach Erfolg) — der Aufrufer setzt hier nur seinen `open`-State zurück,
   *  der restliche Formular-/Ergebnis-State lebt in dieser Komponente selbst
   *  und wird über das native `close`-Event zurückgesetzt (Muster
   *  `new-page-button.tsx`). */
  onClose: () => void
  /** Serialisiert den AKTUELLEN Editor-Stand (Muster `readCurrentContent` in
   *  `editor-root.tsx`, über den vorhandenen Autosave-Serialisierungspfad —
   *  KEINE zweite Serialisierungslogik hier) und ruft `saveAsTemplate`. Ein
   *  Wurf (z. B. Konvertierungsfehler, `ClientApiError` bei 5xx/Netzwerk)
   *  zeigt eine generische Fehlermeldung (Muster `new-page-button.tsx`s
   *  `catch`-Zweig) — nur die dokumentierten 400/403/409-Fälle aus
   *  `SaveAsTemplateResult` bekommen die präzise Server-Meldung. */
  onSubmit: (name: string, description: string | undefined) => Promise<SaveAsTemplateResult>
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; file: string; path: string }
  | { status: 'error'; message: string }

/**
 * „Als Vorlage speichern …"-Dialog (Phase 3c Task 6) — natives `<dialog>`,
 * Muster `new-page-button.tsx` (Trigger sitzt hier NICHT in dieser
 * Komponente selbst, sondern im „Verwerfen"-Dropdown der Statuszeile;
 * `open` kommt deshalb als Prop von `editor-root.tsx`, statt eines eigenen
 * Trigger-Buttons wie bei `NewPageButton`). Felder „Name" (required) und
 * „Beschreibung" (optional) gehen unverändert in `saveAsTemplate` — der
 * Server leitet den Datei-Slug aus `name` ab (`pathSegmentFromTitle`, s.
 * `apps/api/README.md`). Nach Erfolg ersetzt eine Bestätigungszeile mit dem
 * `path` der neuen Vorlage das Formular; „Schließen" ist dann die einzige
 * Aktion (kein zweites unbeabsichtigtes Anlegen durch erneutes Absenden).
 */
export function SaveTemplateDialog({ open, onClose, onSubmit }: SaveTemplateDialogProps) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Das 'close'-Event feuert bei JEDEM Schließen (ESC, Backdrop-Klick, der
  // „Schließen"-Button nach Erfolg) — hier zentral den restlichen State
  // zurücksetzen (Muster `new-page-button.tsx`).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    function onDialogClose() {
      onClose()
      setName('')
      setDescription('')
      setState({ status: 'idle' })
    }
    dialog.addEventListener('close', onDialogClose)
    return () => dialog.removeEventListener('close', onDialogClose)
  }, [onClose])

  function onBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close()
    }
  }

  async function onFormSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmedName = name.trim()
    if (trimmedName.length === 0) return

    setState({ status: 'submitting' })
    try {
      const result = await onSubmit(trimmedName, description.trim() || undefined)
      if (result.ok) {
        setState({ status: 'success', file: result.file, path: result.path })
        return
      }
      setState({ status: 'error', message: result.error })
    } catch {
      setState({ status: 'error', message: t('editor.saveTemplateDialog.genericError') })
    }
  }

  const success = state.status === 'success'

  return (
    <dialog ref={dialogRef} className="newpage-dialog" aria-label={t('editor.saveTemplateDialog.heading')} onClick={onBackdropClick}>
      <div className="dialog-head">
        <h2>{t('editor.saveTemplateDialog.heading')}</h2>
      </div>
      {success ? (
        <>
          <div className="newpage-body">
            {/* Erfolgs- und Fehlermeldung stehen jetzt im Hinweisblock-Baustein
                `.callout` (`styles/43-flaeche.css`) statt in der Statuszeile des
                SUCHDIALOGS — die war hier zweckentfremdet (Bestandsaufnahme
                §2.5, System D) und musste ihren mittigen, großzügigen
                Innenabstand mit einem Inline-Stil wieder abschalten. Beides
                ist entfallen. */}
            <p className="callout ok">
              {t('editor.saveTemplateDialog.savedPrefix')} <code>{state.path}</code>.
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn primary" onClick={() => dialogRef.current?.close()}>
              {t('editor.saveTemplateDialog.close')}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={onFormSubmit}>
          <div className="newpage-body">
            <label>
              {t('editor.saveTemplateDialog.nameLabel')}
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <label>
              {t('editor.saveTemplateDialog.descriptionLabel')}
              <input
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                autoComplete="off"
              />
            </label>
            {state.status === 'error' ? (
              <p className="callout error" role="alert">
                {state.message}
              </p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
              {t('editor.saveTemplateDialog.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={state.status === 'submitting'}>
              {t('editor.saveTemplateDialog.save')}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
