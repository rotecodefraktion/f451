import type { ReactNode } from 'react'

/**
 * Status bar at the foot of `.main` (frame switch `--status-bar: bottom`,
 * f451#60; spec "Statusleiste"). One line, sticky at the bottom of the scroll
 * area, hidden on the phone (`styles/61-lese.css`).
 *
 * Only the frame: the reading view (`page-view.tsx`) puts the status chip,
 * "updated" and the section position in, the edit view (`editor-root.tsx`)
 * the editor's save state. No hooks and no server-only API, so both the
 * server-rendered reading view and the client editor can use it. Anything
 * carrying `.runhead__pos` (the section position) is pushed to the right
 * edge by that class's `margin-left: auto`.
 */
export function StatusBarBottom({ children }: { children: ReactNode }) {
  return <div className="statusbar-bottom">{children}</div>
}
