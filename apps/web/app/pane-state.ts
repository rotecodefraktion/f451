'use client'

import { useEffect, useSyncExternalStore } from 'react'

/** Key in `localStorage`. MUST match `NO_FLASH_PANES` in `layout.tsx` — the
 *  inline script reads the same entry before the first paint, so a pane saved
 *  as collapsed does not flash open first. */
export const PANE_STORAGE_KEY = 'panes'

export interface PaneState {
  nav: boolean
  rail: boolean
}

export type Pane = keyof PaneState

/** Fired on `document` after every change, so every set of switches (edge
 *  grips, top bar buttons) follows the state whoever changed it. */
const PANES_EVENT = 'f451:panes'

/** Reads the state from the root attributes the inline script has set. A
 *  missing attribute (script blocked) means "open" — both panes visible is the
 *  usable state, not the empty one. */
export function readPanes(): PaneState {
  const root = document.documentElement
  return {
    nav: root.getAttribute('data-nav') !== 'off',
    rail: root.getAttribute('data-rail') !== 'off',
  }
}

/** Sets the visible state (root attributes), persists it and notifies every
 *  subscribed switch. */
export function applyPanes(next: PaneState) {
  const root = document.documentElement
  root.setAttribute('data-nav', next.nav ? 'on' : 'off')
  root.setAttribute('data-rail', next.rail ? 'on' : 'off')
  try {
    window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* localStorage may be blocked — switching then lasts for the session only */
  }
  document.dispatchEvent(new Event(PANES_EVENT))
}

export function togglePane(pane: Pane) {
  const current = readPanes()
  applyPanes({ ...current, [pane]: !current[pane] })
}

function subscribe(onChange: () => void) {
  document.addEventListener(PANES_EVENT, onChange)
  return () => document.removeEventListener(PANES_EVENT, onChange)
}

/* `useSyncExternalStore` needs a stable snapshot: one object per state. */
const SNAPSHOTS: Record<string, PaneState> = {}
function snapshot(): PaneState {
  const s = readPanes()
  const key = `${s.nav}|${s.rail}`
  return (SNAPSHOTS[key] ??= s)
}
/* The server HTML (and the hydration render) says "both open"; right after
   hydration React re-reads the client snapshot. Nothing visible depends on it:
   grid and state glyphs hang on the root attribute, only `aria-expanded` does. */
const SERVER_SNAPSHOT: PaneState = { nav: true, rail: true }

/** The current pane state for `aria-expanded`; follows every change. */
export function usePanes(): PaneState {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT)
}

/**
 * Keys `[` (page tree), `]` (info sidebar), `\` (full width: both closed,
 * pressed again both open). No modifier and only outside inputs — in the editor
 * (CodeMirror/TipTap) `[` and `]` are ordinary characters and must stay so.
 *
 * Mount exactly once per page: the set of switches that is rendered (edge grips
 * or top bar buttons) calls it.
 */
export function usePaneShortcuts(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      const target = ev.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const current = readPanes()
      let next: PaneState
      if (ev.key === '[') next = { ...current, nav: !current.nav }
      else if (ev.key === ']') next = { ...current, rail: !current.rail }
      else if (ev.key === '\\') {
        const anyOpen = current.nav || current.rail
        next = { nav: !anyOpen, rail: !anyOpen }
      } else return
      ev.preventDefault()
      applyPanes(next)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
