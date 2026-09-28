/**
 * Reine Hilfsfunktionen für den Topbar-Space-Wechsler
 * (`components/space-switcher.tsx`) — ausgelagert, damit die eigentliche
 * Logik (welcher Space ist aktuell markiert, wie navigieren Pfeiltasten
 * zyklisch durchs Menü) unabhängig vom React-Rendering in `lib/**` getestet
 * werden kann (`vitest.config.ts` deckt nur `lib/**` ab, kein React-DOM).
 */

export interface SpaceSwitcherSpace {
  id: string
  name: string
}

/** Index von `spaceId` in `spaces`, oder `-1` ohne Treffer (z. B. `spaceId`
 *  undefiniert oder kein konfigurierter Space, s. Aufrufer). */
export function indexOfSpace(spaces: SpaceSwitcherSpace[], spaceId?: string): number {
  if (!spaceId) return -1
  return spaces.findIndex((s) => s.id === spaceId)
}

/** Der Space, der im Wechsler als „aktuell" markiert wird (`aria-current`,
 *  Häkchen) — `undefined`, wenn `currentSpaceId` in `spaces` nicht vorkommt
 *  (z. B. Seiten ohne festen Space-Bezug). */
export function resolveCurrentSpace(
  spaces: SpaceSwitcherSpace[],
  currentSpaceId?: string,
): SpaceSwitcherSpace | undefined {
  const index = indexOfSpace(spaces, currentSpaceId)
  return index === -1 ? undefined : spaces[index]
}

/** Zyklischer Ziel-Index für ArrowUp/ArrowDown im geöffneten Space-Menü:
 *  Pfeil-runter am letzten Eintrag springt zurück zum ersten (und umgekehrt).
 *  `currentIndex: -1` (kein Eintrag fokussiert) verhält sich wie Start vor
 *  dem ersten Eintrag. Liefert `-1` bei einer leeren Liste (nichts zu
 *  fokussieren). */
export function cycleIndex(currentIndex: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (currentIndex < 0) return delta === 1 ? 0 : length - 1
  return (currentIndex + delta + length) % length
}
