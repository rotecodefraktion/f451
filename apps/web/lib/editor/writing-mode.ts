import { isPhoneLayout } from '../phone'

/**
 * Writing mode of the phone editor (f451#2): `data-writing` on <html> while the
 * editor has focus. CSS (`66-telefon.css`) uses it to swap the page chrome for
 * the formatting bar and the slim writing header at the top.
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
/** Presses that must never end writing mode — the bar and its sheets, not the
 *  writing header, whose "Done" is meant to end it. */
const PRESS_ZONE = '.phone-toolbar, .phone-more-sheet, .phone-link-sheet'

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
  // Time of the last press inside the keep zone. iOS Safari can still blur
  // the editor on a toolbar tap; a blur right after such a press must not end
  // writing mode (the toolbar and its open sheet would vanish). The editor's
  // state keeps its selection, and the next command focuses it again.
  let keepPressAt = 0

  function onPointerDown(event: PointerEvent) {
    if (event.target instanceof Element && event.target.closest(PRESS_ZONE)) keepPressAt = Date.now()
  }

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
    if (Date.now() - keepPressAt < 800) return
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (!inKeepZone(root, document.activeElement)) html.removeAttribute('data-writing')
    })
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  return () => {
    cancelAnimationFrame(frame)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    html.removeAttribute('data-writing')
  }
}
