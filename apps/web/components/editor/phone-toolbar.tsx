'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { useT } from '../../lib/i18n/provider'
import { moreSheetItems, nextHeadingLevel, PHONE_TOOLBAR, type PhoneToolbarId } from '../../lib/editor/phone-toolbar-items'
import { WRITING_DONE_EVENT } from '../../lib/editor/writing-mode'
import { LinkPopover } from './editor-toolbar'

export interface PhoneToolbarProps {
  editor: Editor
  onPickImage: () => void
}

type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Every button keeps the focus in the editor: a press that moved focus would
 *  close the on-screen keyboard. The action runs on click. Both events are
 *  needed: iOS Safari moves focus on the compatibility `mousedown` even when
 *  `pointerdown` was cancelled. */
function keepEditorFocus(event: React.PointerEvent | React.MouseEvent) {
  event.preventDefault()
}

/**
 * Formatting bar above the on-screen keyboard (f451#2). Only visible in the phone
 * layout while the editor has focus (`html[data-writing]`, `66-telefon.css`); the
 * desktop `EditorToolbar` is hidden there instead. Active state via
 * `useEditorState`, same pattern as `editor-toolbar.tsx`.
 */
export function PhoneToolbar({ editor, onPickImage }: PhoneToolbarProps) {
  const { t } = useT()
  const [moreOpen, setMoreOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)

  // Link fields derived as in `editor-toolbar.tsx`, so the link sheet gets the
  // same props as the desktop popover.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      code: e.isActive('code'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      heading: (e.isActive('heading') ? ((e.getAttributes('heading').level as number | undefined) ?? 0) : 0) as HeadingLevel,
      link: e.isActive('link'),
      linkHref: (e.getAttributes('link').href as string | undefined) ?? '',
      selectionEmpty: e.state.selection.empty,
      selectedText: e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, ''),
    }),
  })

  // "Done" in the writing header (`writing-header.tsx`): close both sheets and
  // let go of the editor, so the keyboard closes and writing mode ends.
  useEffect(() => {
    function onDone() {
      setMoreOpen(false)
      setLinkOpen(false)
      editor.commands.blur()
    }
    window.addEventListener(WRITING_DONE_EVENT, onDone)
    return () => window.removeEventListener(WRITING_DONE_EVENT, onDone)
  }, [editor])

  function closeLink() {
    setLinkOpen(false)
    // Submit and remove already refocus the editor; cancel leaves the focus in
    // the unmounting input, which would end writing mode.
    if (!editor.isFocused) editor.commands.focus()
  }

  function cycleHeading() {
    const level = nextHeadingLevel(state.heading)
    if (level === 0) editor.chain().focus().setParagraph().run()
    else editor.chain().focus().toggleHeading({ level }).run()
  }

  const actions: Record<PhoneToolbarId, () => void> = {
    heading: cycleHeading,
    bold: () => editor.chain().focus().toggleBold().run(),
    code: () => editor.chain().focus().toggleCode().run(),
    link: () => {
      setMoreOpen(false)
      setLinkOpen((open) => !open)
    },
    bulletList: () => editor.chain().focus().toggleBulletList().run(),
    orderedList: () => editor.chain().focus().toggleOrderedList().run(),
    image: onPickImage,
    undo: () => editor.chain().focus().undo().run(),
    more: () => {
      setLinkOpen(false)
      setMoreOpen((open) => !open)
    },
  }

  const pressed: Partial<Record<PhoneToolbarId, boolean>> = {
    heading: state.heading !== 0,
    bold: state.bold,
    code: state.code,
    bulletList: state.bulletList,
    orderedList: state.orderedList,
  }

  // The slash menu runs `item.run(editor)` after deleting the typed `/query`
  // (`ui-extensions.ts#slashCommandExtension`); here there is no query to delete,
  // so the item command runs as is. Italic has no slash item — the sheet adds it.
  const sheetRows: Array<{ id: string; label: string; hint?: string; run: () => void }> = [
    { id: 'italic', label: t('editor.phoneToolbar.italic'), run: () => editor.chain().focus().toggleItalic().run() },
    // The slash menu runs at a caret, usually on an empty line. From the sheet
    // the selection may hold text or sit mid-paragraph: blocks are inserted
    // after the current block instead of replacing or splitting it; the
    // footnote reference goes to the end of the selection (italic above works
    // on the selection itself).
    ...moreSheetItems(t).map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      run: () => {
        const { $to, to } = editor.state.selection
        editor.commands.setTextSelection(item.id === 'footnote' ? to : $to.end())
        item.run(editor)
      },
    })),
  ]

  function choose(run: () => void) {
    run()
    setMoreOpen(false)
    if (!editor.isFocused) editor.commands.focus()
  }

  return (
    <>
      <div className="phone-toolbar" role="toolbar" aria-label={t('editor.phoneToolbar.label')}>
        {PHONE_TOOLBAR.map((id) => {
          const isOn = pressed[id]
          return (
            <button
              key={id}
              type="button"
              className={`tb${id === 'bold' ? ' b' : ''}${id === 'code' ? ' mono' : ''}${isOn ? ' on' : ''}`}
              aria-label={t(`editor.phoneToolbar.${id}`)}
              aria-pressed={isOn === undefined ? undefined : isOn}
              aria-expanded={id === 'more' ? moreOpen : id === 'link' ? linkOpen : undefined}
              onPointerDown={keepEditorFocus}
              onMouseDown={keepEditorFocus}
              onClick={actions[id]}
            >
              {ICONS[id]}
            </button>
          )
        })}
      </div>
      <div
        className="phone-more-sheet"
        role="dialog"
        aria-label={t('editor.phoneToolbar.moreTitle')}
        data-open={moreOpen ? '' : undefined}
      >
        <div className="phone-more-title">{t('editor.phoneToolbar.moreTitle')}</div>
        {moreOpen
          ? sheetRows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="phone-more-row"
                onPointerDown={keepEditorFocus}
                onMouseDown={keepEditorFocus}
                onClick={() => choose(row.run)}
              >
                <b>{row.label}</b>
                {row.hint ? <span>{row.hint}</span> : null}
              </button>
            ))
          : null}
      </div>
      {/* Link box as a bottom sheet above the bar; the desktop popover is
          hidden with the `.etoolbar` in the phone layout. Mounted only while
          open: `LinkPopover` takes the current link as its start value. */}
      <div className="phone-link-sheet" data-open={linkOpen ? '' : undefined}>
        {linkOpen ? (
          <LinkPopover
            editor={editor}
            currentHref={state.linkHref}
            hasLink={state.link}
            selectedText={state.selectedText}
            canSetLink={!state.selectionEmpty || state.link}
            onClose={closeLink}
          />
        ) : null}
      </div>
    </>
  )
}

// Icons: the SVGs of `editor-toolbar.tsx` where the desktop bar has the same
// command, text glyphs otherwise.
const ICONS: Record<PhoneToolbarId, ReactNode> = {
  heading: 'H',
  bold: 'B',
  code: '</>',
  link: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  bulletList: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
      <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  orderedList: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M10 6h11M10 12h11M10 18h11" strokeLinecap="round" />
      <path
        d="M4.6 5.4h1v4M4.2 9.4h2.8M4.4 13.6h2a1 1 0 0 1 0 2h-.8M4.4 13.6a1 1 0 0 1 1.8-.5M4 20h2.6a1 1 0 0 0 0-2H5a1 1 0 0 1 0-2h1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.8" />
      <path d="m4 18 5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  undo: '↶',
  more: '⋯',
}
