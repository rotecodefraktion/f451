/**
 * The frame of a page as the server components render it, derived from the
 * resolved frame switches (structure spec 2). Pure, so the rules are testable
 * without a request.
 *
 * - Missing or unknown values fall back to the Editorial defaults
 *   (`topbar: off`, `page-head: title`, `pane-controls: edges`, `status-bar: off`).
 * - `paneControls: 'topbar'` only when the top bar is actually shown; otherwise
 *   the edge grips stay, so a pane can always be opened (a hand-edited theme may
 *   break the `pane-controls-needs-topbar` rule).
 * - Pages without a page tree (graph, settings, error pages) keep the top bar
 *   whatever `topbar` says, and with it the edge grips.
 */
export interface FrameShape {
  /** `false` only when the page has a tree (see `hasTree`). */
  topbar: boolean
  pageHead: 'title' | 'toolbar'
  paneControls: 'edges' | 'topbar'
  statusBar: boolean
}

export function frameShape(
  switches: Record<string, string> | undefined,
  opts: { hasTree: boolean },
): FrameShape {
  const s = switches ?? {}
  const topbar = !opts.hasTree || s.topbar === 'on'
  const paneControls = opts.hasTree && topbar && s['pane-controls'] === 'topbar' ? 'topbar' : 'edges'
  return {
    topbar,
    pageHead: s['page-head'] === 'toolbar' ? 'toolbar' : 'title',
    paneControls,
    statusBar: s['status-bar'] === 'bottom',
  }
}
