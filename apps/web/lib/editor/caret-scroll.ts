/**
 * Caret handling of the phone editor (f451#2): how far to scroll so the caret
 * stays visible between the writing header at the top and the formatting bar
 * above the on-screen keyboard. All values in one coordinate system (the
 * caller uses client coordinates of the layout viewport).
 */

/** Pixels to scroll so the caret sits inside [view.top + margin, view.visibleBottom − toolbarHeight − margin]; 0 when inside; negative scrolls up. */
export function caretScrollDelta(
  caret: { top: number; bottom: number },
  view: { top: number; visibleBottom: number },
  toolbarHeight: number,
  margin = 16,
): number {
  const bandTop = view.top + margin
  const bandBottom = view.visibleBottom - toolbarHeight - margin
  if (caret.bottom > bandBottom) return caret.bottom - bandBottom
  if (caret.top < bandTop) return caret.top - bandTop
  return 0
}
