// Dünner Wrapper um die Excalidraw-Utilities — Client-only (Excalidraw rendert
// nicht unter SSR; der Import passiert ausschließlich aus 'use client'-Kontext
// und wird via dynamic import erst im Dialog geladen).
//
// Typ-Importpfad: `@excalidraw/excalidraw/types` (0.18 exportiert die Typen laut
// package.json-`exports`-Map unter `./dist/types/excalidraw/types.d.ts`, s.
// dortige `"./*"`-Regel — mit typecheck gegen die installierte Version geprüft).
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

/** .excalidraw.svg-Text → Excalidraw-Szene (loadFromBlob erkennt den
 *  payload-Kommentar in der SVG). Wirft bei SVGs ohne Excalidraw-Payload. */
export async function sceneFromSvgText(svgText: string) {
  const { loadFromBlob } = await import('@excalidraw/excalidraw')
  return loadFromBlob(new Blob([svgText], { type: 'image/svg+xml' }), null, null)
}

/** Aktuelle Szene → SVG-Text MIT eingebetteter Szene (exportEmbedScene). */
export async function sceneToSvgText(api: ExcalidrawImperativeAPI): Promise<string> {
  const { exportToSvg } = await import('@excalidraw/excalidraw')
  const svg = await exportToSvg({
    elements: api.getSceneElements(),
    // exportEmbedScene bettet die Szene als payload-Kommentare in die SVG —
    // genau das Format, das sceneFromSvgText/loadFromBlob wieder liest und
    // dessen Kommentare der Server-Sanitizer seit Task 1 erhält.
    appState: { ...api.getAppState(), exportEmbedScene: true },
    files: api.getFiles(),
  })
  return new XMLSerializer().serializeToString(svg)
}
