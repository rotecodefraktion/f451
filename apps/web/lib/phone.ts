// JS twin of the phone threshold in `app/styles/66-telefon.css` (f451#1). Use it
// only where CSS cannot decide (e.g. which items a menu offers); everything that
// is purely visual stays in the stylesheet. Keep both thresholds identical.

export const PHONE_QUERY = '(max-width: 699px) and (pointer: coarse)'

/** True when the phone layout applies. False outside the browser (SSR, node
 *  tests) or when `matchMedia` is unavailable. */
export function isPhoneLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(PHONE_QUERY).matches
}
