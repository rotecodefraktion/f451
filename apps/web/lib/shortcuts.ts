/**
 * Entscheidung, ob ein Tastendruck den Tastenkürzel-Dialog öffnen soll
 * (`components/shortcuts-dialog.tsx`).
 *
 * Warum als reine Funktion und nicht direkt im Effekt der Komponente: `?` ist
 * ein modifikatorloses Einzeltastenkürzel und damit dieselbe Gratwanderung wie
 * `[`/`]`/`\` in `app/pane-edges.tsx` — es darf NIE greifen, während jemand
 * schreibt, sonst schluckt es das Fragezeichen im Text. Diese Bedingung ist
 * das eigentlich Prüfenswerte; hier steht sie ohne DOM und ohne React und ist
 * damit in `lib/shortcuts.test.ts` direkt belegbar (dasselbe Muster wie
 * `lib/tree-expansion.ts` zu `components/tree-expansion.tsx`).
 */

/** Das Element, auf dem der Fokus beim Tastendruck stand — nur die zwei
 *  Angaben, die für die Entscheidung zählen. */
export interface ShortcutTarget {
  /** Großgeschrieben wie `HTMLElement#tagName` (z. B. `'INPUT'`). */
  tagName: string
  isContentEditable: boolean
}

/** Ein Tastendruck, reduziert auf das Entscheidungserhebliche. */
export interface ShortcutKeyPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** `null`, wenn das Ereignis kein Element als Ziel trägt. */
  target: ShortcutTarget | null
}

/** Eingaben, in denen `?` ein gewöhnliches Zeichen ist und bleiben muss. */
const TEXT_INPUT_TAGS = /^(INPUT|TEXTAREA|SELECT)$/

/**
 * `?` öffnet die Übersicht — ohne Modifikator und nur außerhalb von Eingaben.
 *
 * `Shift` wird ABSICHTLICH nicht ausgeschlossen: auf deutscher wie englischer
 * Belegung entsteht `?` überhaupt erst mit Shift.
 */
export function shouldOpenShortcuts(press: ShortcutKeyPress): boolean {
  if (press.key !== '?') return false
  if (press.ctrlKey || press.metaKey || press.altKey) return false
  const target = press.target
  if (!target) return true
  if (target.isContentEditable) return false
  return !TEXT_INPUT_TAGS.test(target.tagName)
}
