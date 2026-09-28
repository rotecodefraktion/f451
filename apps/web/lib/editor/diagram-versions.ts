// Versionszähler pro (pageId, path) — die Diagramm-NodeView hängt `&v=<n>` an die
// Media-URL, damit das <img> nach dem Speichern (Task 4/5: bumpDiagramVersion)
// garantiert neu lädt (Server sendet für ref=draft zwar no-store, aber das im DOM
// stehende <img> lädt ohne src-Änderung nicht neu).
type Listener = (pageId: string, path: string) => void

const versions = new Map<string, number>()
const listeners = new Set<Listener>()

const key = (pageId: string, path: string) => `${pageId}:${path}`

export function diagramVersion(pageId: string, path: string): number {
  return versions.get(key(pageId, path)) ?? 0
}

export function bumpDiagramVersion(pageId: string, path: string): void {
  versions.set(key(pageId, path), diagramVersion(pageId, path) + 1)
  for (const listener of listeners) listener(pageId, path)
}

export function subscribeDiagramVersions(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
