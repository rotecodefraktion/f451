'use client'

import { useT } from '../lib/i18n/provider.js'
import { type Pane, togglePane, usePaneShortcuts, usePanes } from './pane-state'

export interface PaneBarToggleProps {
  pane: Pane
  /** Registers the keys `[`, `]`, `\`. Exactly one rendered switch per page
   *  does it (the shell passes it to the page tree button). */
  shortcuts?: boolean
}

/**
 * A pane switch in the top bar (`--pane-controls: topbar`): the same state as
 * the edge grips (`pane-edges.tsx`, `pane-state.ts`), as a 44 × 44 px icon
 * button. The glyph follows the root attribute (`60-chrome-raster.css`), not
 * `aria-expanded`, so it is right before hydration too. Hidden on the phone,
 * whose bar has its own switches.
 */
export function PaneBarToggle({ pane, shortcuts = false }: PaneBarToggleProps) {
  const { t } = useT()
  const panes = usePanes()
  usePaneShortcuts(shortcuts)
  return (
    <button
      type="button"
      className={
        pane === 'nav' ? 'bar-pane-toggle bar-pane-toggle--nav' : 'bar-pane-toggle bar-pane-toggle--rail'
      }
      aria-expanded={panes[pane]}
      aria-controls={pane === 'nav' ? 'pane-nav' : 'pane-rail'}
      aria-label={t(pane === 'nav' ? 'shell.panes.nav.label' : 'shell.panes.rail.label')}
      title={t(pane === 'nav' ? 'shell.panes.nav.title' : 'shell.panes.rail.title')}
      onClick={() => togglePane(pane)}
    >
      <span className="glyph" aria-hidden="true" />
    </button>
  )
}
