// Offline-Puffer für Editor-Autosaves: reines Modul ohne React/Server-Abhängigkeiten.
// Speichert pro Seite (pageId) einen Entwurf im localStorage, damit ein Autosave-Fehlschlag
// (z. B. Netzwerkausfall) den Stand nicht verliert. Tasks 2/3 verdrahten dies in Autosave
// und Mount-Recovery (Spec §9).

const KEY_PREFIX = 'f451.offline.'

export interface OfflineDraft {
  content: string // volles Markdown inkl. Frontmatter (der Stand, der gespeichert werden sollte)
  baseSha: string // SHA-Kette des Autosave-Vertrags (2c) — für den Save nach Recovery
  branch: string // Draft-Branch zur Plausibilitätsprüfung beim Recovery
  savedAt: string // ISO-Zeitstempel der Pufferung (Anzeige im Recovery-Dialog)
}

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null // Safari-Private-Mode u. ä. können schon beim Zugriff werfen
  }
}

/** true = gesichert; false = localStorage nicht verfügbar/voll (Quota) — Aufrufer
 *  zeigt dann den error-Zustand statt des offline-Zustands. */
export function writeOfflineDraft(pageId: string, draft: OfflineDraft): boolean {
  const store = storage()
  if (!store) return false
  try {
    store.setItem(`${KEY_PREFIX}${pageId}`, JSON.stringify(draft))
    return true
  } catch {
    return false // QuotaExceeded → Aufrufer degradiert zum error-Zustand
  }
}

/** null bei fehlend/korrupt (korrupte Einträge werden dabei entfernt). */
export function readOfflineDraft(pageId: string): OfflineDraft | null {
  const store = storage()
  if (!store) return null
  let raw: string | null
  try {
    raw = store.getItem(`${KEY_PREFIX}${pageId}`)
  } catch {
    return null // getItem kann werfen (z. B. SecurityError) — nie nach oben propagieren
  }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as OfflineDraft
    if (
      typeof parsed?.content !== 'string' ||
      typeof parsed?.baseSha !== 'string' ||
      typeof parsed?.branch !== 'string' ||
      typeof parsed?.savedAt !== 'string'
    )
      throw new Error('korrupt')
    return parsed
  } catch {
    clearOfflineDraft(pageId) // korrupte Einträge nicht wieder und wieder anfassen
    return null
  }
}

export function clearOfflineDraft(pageId: string): void {
  try {
    storage()?.removeItem(`${KEY_PREFIX}${pageId}`)
  } catch {
    // removeItem kann werfen — still ignorieren, damit der Korruptions-Pfad von
    // readOfflineDraft (clear im catch) nie ungefangen nach oben propagiert.
  }
}
