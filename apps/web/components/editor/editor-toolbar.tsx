'use client'

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { useT } from '../../lib/i18n/provider'
import type { T } from '../../lib/i18n/types'

export interface EditorToolbarProps {
  editor: Editor
  linkPopoverOpen: boolean
  onOpenLinkPopover: () => void
  onCloseLinkPopover: () => void
}

const HEADING_LEVELS = [1, 2, 3] as const

function formatLabel(state: { heading: 1 | 2 | 3 | 0 }, t: T): string {
  if (state.heading) return t('editor.toolbar.heading', { level: state.heading })
  return t('editor.toolbar.paragraph')
}

/**
 * Schlanke Formatier-Toolbar (`.etoolbar`, Mockup `docs/design/mockups/editor.html`).
 * Liest den aktiven Zustand reaktiv über `useEditorState` (Tiptap-v3-Muster: der
 * Selektor läuft bei jeder Transaktion, ein Re-Render passiert nur, wenn sich das
 * Ergebnis tatsächlich ändert — kein manuelles `onUpdate`-Re-Render-Bookkeeping nötig).
 *
 * ⌘K-Öffnen des Link-Popovers passiert NICHT hier (die Tastatur kann jederzeit
 * unabhängig vom Toolbar-Fokus im Editor-Inhalt gedrückt werden) — das übernimmt
 * `wysiwyg-editor.tsx` über `editorProps.handleKeyDown` (`stopPropagation`, damit der
 * globale ⌘K-Suchdialog nicht öffnet) und reicht `linkPopoverOpen` als Prop herein.
 */
export function EditorToolbar({ editor, linkPopoverOpen, onOpenLinkPopover, onCloseLinkPopover }: EditorToolbarProps) {
  const { t } = useT()
  const [formatMenuOpen, setFormatMenuOpen] = useState(false)

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      linkHref: (e.getAttributes('link').href as string | undefined) ?? '',
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      heading: (e.isActive('heading', { level: 1 })
        ? 1
        : e.isActive('heading', { level: 2 })
          ? 2
          : e.isActive('heading', { level: 3 })
            ? 3
            : 0) as 0 | 1 | 2 | 3,
      selectionEmpty: e.state.selection.empty,
      selectedText: e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, ''),
      wordCount: countWords(e.state.doc.textContent),
    }),
  })

  function applyFormat(level: 0 | 1 | 2 | 3) {
    if (level === 0) {
      editor.chain().focus().setParagraph().run()
    } else {
      editor.chain().focus().toggleHeading({ level }).run()
    }
    setFormatMenuOpen(false)
  }

  const readingMinutes = Math.max(1, Math.round(state.wordCount / 200))

  return (
    <div className="etoolbar" role="toolbar" aria-label={t('editor.toolbar.ariaLabel')}>
      <div className="selbox">
        <button
          type="button"
          className="tb fmt"
          aria-haspopup="true"
          aria-expanded={formatMenuOpen}
          onClick={() => setFormatMenuOpen((open) => !open)}
        >
          {formatLabel(state, t)}
          <svg className="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
            <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {formatMenuOpen ? (
          <div className="menu" role="menu">
            <button type="button" role="menuitem" className="menu-item" onClick={() => applyFormat(0)}>
              {t('editor.toolbar.paragraph')}
            </button>
            {HEADING_LEVELS.map((level) => (
              <button type="button" role="menuitem" className="menu-item" key={level} onClick={() => applyFormat(level)}>
                {t('editor.toolbar.heading', { level })}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <span className="tsep" />
      <div className="tgrp">
        <button
          type="button"
          className={`tb b${state.bold ? ' on' : ''}`}
          title={t('editor.toolbar.boldTitle')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className={`tb i${state.italic ? ' on' : ''}`}
          title={t('editor.toolbar.italicTitle')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </button>
        <button
          type="button"
          className={`tb mono${state.code ? ' on' : ''}`}
          title={t('editor.toolbar.codeTitle')}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          {'</>'}
        </button>
      </div>

      <span className="tsep" />
      <div className="tgrp rel">
        <button
          type="button"
          className={`tb${state.link ? ' on' : ''}`}
          title={t('editor.toolbar.linkTitle')}
          onClick={onOpenLinkPopover}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path
              d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {linkPopoverOpen ? (
          <LinkPopover
            editor={editor}
            currentHref={state.linkHref}
            hasLink={state.link}
            selectedText={state.selectedText}
            canSetLink={!state.selectionEmpty || state.link}
            onClose={onCloseLinkPopover}
          />
        ) : null}

        <button
          type="button"
          className={`tb${state.bulletList ? ' on' : ''}`}
          title={t('editor.toolbar.bulletListTitle')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
            <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
            <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
            <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <button
          type="button"
          className={`tb${state.orderedList ? ' on' : ''}`}
          title={t('editor.toolbar.orderedListTitle')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M10 6h11M10 12h11M10 18h11" strokeLinecap="round" />
            <path
              d="M4.6 5.4h1v4M4.2 9.4h2.8M4.4 13.6h2a1 1 0 0 1 0 2h-.8M4.4 13.6a1 1 0 0 1 1.8-.5M4 20h2.6a1 1 0 0 0 0-2H5a1 1 0 0 1 0-2h1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className={`tb${state.taskList ? ' on' : ''}`}
          title={t('editor.toolbar.taskListTitle')}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="4" y="5" width="5" height="5" rx="1" />
            <path d="m5 7.3 1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 7h8" strokeLinecap="round" />
            <rect x="4" y="14" width="5" height="5" rx="1" />
            <path d="M12 16h8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <span className="tsep" />
      <div className="tgrp">
        <button
          type="button"
          className="tb"
          title={t('editor.toolbar.tableTitle')}
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 10h18M3 15h18M9 4v16M15 4v16" strokeLinecap="round" />
          </svg>
        </button>
        {/* Öffnet den Datei-Dialog über denselben Custom-Command wie das Slash-Item
            „Bild/Datei" (`editor.commands.triggerImageUpload()`, s.
            lib/editor/ui-extensions.ts#ImageUploadTrigger) — akzeptiert Bilder UND
            die erlaubten Dokument-Anhänge (PDF/Office/ZIP/Text), der eigentliche
            Upload läuft danach in wysiwyg-editor.tsx (`handleUploadFiles`). */}
        <button
          type="button"
          className="tb"
          title={t('editor.toolbar.imageTitle')}
          onClick={() => editor.commands.triggerImageUpload()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9.5" r="1.8" />
            <path d="m4 18 5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <span className="grow" />
      <span className="wordcount">{t('editor.toolbar.wordCount', { count: state.wordCount, minutes: readingMinutes })}</span>
    </div>
  )
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

interface LinkPopoverProps {
  editor: Editor
  currentHref: string
  hasLink: boolean
  selectedText: string
  canSetLink: boolean
  onClose: () => void
}

/** Link-Popover (`.pop`) — Prompt-frei: URL-Eingabe statt `window.prompt`. Setzt NIE
 *  einen `[text](url)`-Link mit `text === url` (der serialisiert zwingend zur nackten
 *  Autolink-Form, s. `packages/editor/src/to-markdown.ts`) — lässt Text und URL
 *  identisch, wird stattdessen das `literal: true`-Attribut gesetzt (die
 *  Autolink-Form des Schemas, `packages/editor/src/extensions.ts:94-105`). */
function LinkPopover({ editor, currentHref, hasLink, selectedText, canSetLink, onClose }: LinkPopoverProps) {
  const { t } = useT()
  const [url, setUrl] = useState(currentHref)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setUrl(currentHref)
    requestAnimationFrame(() => inputRef.current?.focus())
    // Öffnet sich neu bei jedem Popover-Aufruf — currentHref ist zu diesem Zeitpunkt
    // der aktuelle Wert, weitere Änderungen sollen den Eingabewert NICHT überschreiben.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = url.trim()
    // Der Submit-Button ist zwar bereits disabled, ein Enter-Tastendruck im
    // Eingabefeld kann das Formular aber trotzdem auslösen — deshalb dieselbe
    // Bedingung hier noch einmal explizit prüfen.
    if (!trimmed || !canSetLink) return
    const literal = trimmed === selectedText
    // `setLink` prüft die erlaubten URL-Protokolle (this.options.isAllowedUri) —
    // deshalb bewusst NICHT durch das generische `setMark` ersetzt. Das
    // `literal`-Attribut (2b-Regel: NIE `[text](url)` mit text===url, s.
    // Kopfkommentar) ist aber nicht Teil von `setLink`s TS-Signatur (die kommt
    // aus der UNveränderten Basis-Extension, s. @tiptap/extension-link) — daher
    // im selben Chain-Schritt zusätzlich per `updateAttributes` gesetzt.
    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: trimmed })
      .updateAttributes('link', { literal })
      .run()
    onClose()
  }

  function remove() {
    editor.chain().focus().unsetLink().run()
    onClose()
  }

  return (
    <div className="menu linkpop" role="dialog" aria-label={t('editor.toolbar.linkPopover.ariaLabel')}>
      <form onSubmit={submit}>
        <div className="ph">{t('editor.toolbar.linkPopover.heading')}</div>
        <div className="fld">
          <input
            ref={inputRef}
            className="input"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t('editor.toolbar.linkPopover.urlPlaceholder')}
            aria-label={t('editor.toolbar.linkPopover.urlAriaLabel')}
          />
          {!canSetLink ? <p className="hint">{t('editor.toolbar.linkPopover.selectTextHint')}</p> : null}
        </div>
        <div className="pf">
          <button type="submit" className="btn primary" disabled={!canSetLink || url.trim().length === 0}>
            {t('editor.toolbar.linkPopover.submit')}
          </button>
          {hasLink ? (
            <button type="button" className="btn" onClick={remove}>
              {t('editor.toolbar.linkPopover.remove')}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            {t('editor.toolbar.linkPopover.cancel')}
          </button>
        </div>
      </form>
    </div>
  )
}
