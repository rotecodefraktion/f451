/**
 * Height of the on-screen keyboard for the phone toolbar (f451#2).
 *
 * iOS Safari does not resize the layout when the keyboard opens; only the
 * visual viewport shrinks (and may scroll, `offsetTop`). The part of the
 * layout viewport below the visual one is what the keyboard covers. On
 * Android with `interactive-widget=resizes-content` the layout shrinks
 * itself and the inset stays 0.
 */

/** Height covered by the on-screen keyboard: innerHeight − (vv.height + vv.offsetTop), never below 0, rounded. */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(innerHeight - (vv.height + vv.offsetTop)))
}

/** Sets `--kb-inset` (px) on `<html>` from `window.visualViewport` while
 *  mounted and removes it again on cleanup. No-op without a visual viewport. */
export function trackKeyboardInset(): () => void {
  if (typeof window === 'undefined' || !window.visualViewport) return () => {}
  const vv = window.visualViewport
  const root = document.documentElement
  const update = () => root.style.setProperty('--kb-inset', `${keyboardInset(window.innerHeight, vv)}px`)
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    root.style.removeProperty('--kb-inset')
  }
}
