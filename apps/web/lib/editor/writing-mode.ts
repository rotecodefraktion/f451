import { isPhoneLayout } from '../phone'

/**
 * Writing mode of the phone editor (f451#2): `data-writing` on <html> while the
 * editor has focus. CSS (`66-telefon.css`) uses it to swap the page chrome for
 * the formatting bar above the keyboard and the slim writing header.
 *
 * Focus may move from the editor into the bar, its sheets or the writing header
 * without leaving writing mode — those are the "keep zone" below. The writing
 * header belongs to it because its "Done" button takes focus on pointerdown:
 * leaving writing mode at that moment would hide the button before its click.
 */

/** Dispatched on `window` by the writing header's "Done" button: the phone
 *  toolbar closes its sheets and blurs the editor. */
export const WRITING_DONE_EVENT = 'f451:writing-done'

const KEEP_ZONE = '.phone-toolbar, .phone-more-sheet, .phone-link-sheet, .writing-header'

function inKeepZone(root: HTMLElement, node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false
  return root.contains(node) || node.closest(KEEP_ZONE) !== null
}

/** Sets `data-writing` on <html> while focus is inside `root` (or moves on into
 *  the keep zone); only in the phone layout. Returns the cleanup, which removes
 *  the listeners and the attribute. */
export function attachWritingMode(root: HTMLElement): () => void {
  const html = document.documentElement
  let frame = 0

  function onFocusIn(event: FocusEvent) {
    if (!isPhoneLayout()) return
    if (event.target instanceof Node && root.contains(event.target)) html.setAttribute('data-writing', '')
  }

  // Listens on the document, not on `root`: focus can leave writing mode from
  // an element of the keep zone outside `root` (e.g. the link sheet's input).
  function onFocusOut(event: FocusEvent) {
    if (!html.hasAttribute('data-writing')) return
    if (!inKeepZone(root, event.target)) return
    if (event.relatedTarget !== null) {
      if (!inKeepZone(root, event.relatedTarget)) html.removeAttribute('data-writing')
      return
    }
    // No `relatedTarget`: focus went to nothing focusable, or the browser does
    // not report the target (iOS Safari does not focus buttons on tap). Decide
    // once the focus has settled.
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (!inKeepZone(root, document.activeElement)) html.removeAttribute('data-writing')
    })
  }

  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  return () => {
    cancelAnimationFrame(frame)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    html.removeAttribute('data-writing')
  }
}
