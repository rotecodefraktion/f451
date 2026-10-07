'use client'

import type { AutosaveStatus } from '../../lib/editor/autosave'
import { WRITING_DONE_EVENT } from '../../lib/editor/writing-mode'
import { useT } from '../../lib/i18n/provider'
import { SaveState } from './status-bar'

export interface WritingHeaderProps {
  saveStatus: AutosaveStatus
  savedAt: string | null
}

/**
 * Slim header of the phone writing mode (f451#2): save state and "Done".
 * Always in the DOM; CSS shows it only in the phone layout under
 * `html[data-writing]` (`66-telefon.css`), in place of the editor's status bar.
 *
 * "Done" keeps the default pointerdown (it takes the focus, unlike the toolbar
 * buttons) and is part of the writing-mode keep zone (`lib/editor/writing-mode.ts`),
 * so the header stays visible until its click has run.
 */
export function WritingHeader({ saveStatus, savedAt }: WritingHeaderProps) {
  const { t } = useT()

  function done() {
    // The phone toolbar closes its sheets and blurs the editor.
    window.dispatchEvent(new Event(WRITING_DONE_EVENT))
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  }

  return (
    <div className="writing-header">
      <SaveState saveStatus={saveStatus} savedAt={savedAt} />
      <span className="grow" />
      <button type="button" className="btn writing-done" onClick={done}>
        {t('editor.writing.done')}
      </button>
    </div>
  )
}
