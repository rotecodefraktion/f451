import type { T } from '../i18n/types.js'
import { filterSlashItems, type SlashItem } from './slash-items.js'

// Formatting bar above the on-screen keyboard (f451#2). Pure module: the
// component (`components/editor/phone-toolbar.tsx`) only wires these to Tiptap.

export type PhoneToolbarId =
  | 'heading'
  | 'bold'
  | 'code'
  | 'link'
  | 'bulletList'
  | 'orderedList'
  | 'image'
  | 'undo'
  | 'more'

/** Buttons of the phone bar, in display order. */
export const PHONE_TOOLBAR: readonly PhoneToolbarId[] = [
  'heading',
  'bold',
  'code',
  'link',
  'bulletList',
  'orderedList',
  'image',
  'undo',
  'more',
]

/** One tap on "Heading" cycles paragraph → H2 → H3 → paragraph. H1 (the page
 *  title level) joins the cycle at H2; H4–H6 fall back to a paragraph. */
export function nextHeadingLevel(current: 0 | 1 | 2 | 3 | 4 | 5 | 6): 0 | 2 | 3 {
  switch (current) {
    case 0:
    case 1:
      return 2
    case 2:
      return 3
    default:
      return 0
  }
}

/** Slash items already reachable from the bar itself — left out of the sheet. */
const ON_BAR_IDS: ReadonlySet<string> = new Set([
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'image',
])

/** Items of the "More" sheet: the phone slash menu minus what the bar offers. */
export function moreSheetItems(t: T): SlashItem[] {
  return filterSlashItems('', t, { phone: true }).filter((item) => !ON_BAR_IDS.has(item.id))
}
