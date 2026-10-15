/**
 * Placement of the link hover preview (#100). Pure so it can be tested
 * without a DOM: the caller passes the link's bounding rect, the measured
 * size of the preview box and the viewport size (all in CSS pixels,
 * viewport-relative — the box is `position: fixed`).
 *
 * The box goes below the link unless it would overflow the viewport bottom
 * AND there is room above; with no room either way it stays below. The left
 * edge follows the link, clamped so the box keeps an 8px margin to both
 * viewport edges (the left margin wins when the box is wider than the
 * viewport).
 */

const EDGE = 8

export function previewPosition(
  link: { top: number; bottom: number; left: number },
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
): { top: number; left: number; placement: 'below' | 'above' } {
  const belowTop = link.bottom + gap
  const aboveTop = link.top - gap - box.height
  const fitsBelow = belowTop + box.height <= viewport.height
  const placement = !fitsBelow && aboveTop >= 0 ? 'above' : 'below'
  const maxLeft = viewport.width - box.width - EDGE
  const left = Math.max(EDGE, Math.min(link.left, maxLeft))
  return { top: placement === 'above' ? aboveTop : belowTop, left, placement }
}
