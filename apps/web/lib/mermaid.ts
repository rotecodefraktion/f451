/**
 * Mermaid diagrams in the reading view (#104). The server emits fenced
 * ```mermaid blocks as plain code; the client turns them into SVG. The
 * pure parts (theme choice, sequential rendering with per-diagram failure)
 * live here so they are testable without a DOM.
 */

export type MermaidTheme = 'default' | 'dark'

/**
 * Picks the mermaid theme from `data-theme` on <html> (set by the theme
 * toggle and the inline head script to 'light' or 'dark'); without an
 * explicit choice the system preference decides.
 */
export function mermaidTheme(dataTheme: string | undefined, prefersDark: boolean): MermaidTheme {
  if (dataTheme === 'dark') return 'dark'
  if (dataTheme === 'light') return 'default'
  return prefersDark ? 'dark' : 'default'
}

export interface MermaidRenderer {
  render(id: string, source: string): Promise<{ svg: string }>
}

export type MermaidResult = { svg: string } | { error: true }

/**
 * Renders all sources one after another — mermaid is not reentrant, parallel
 * `render` calls interfere. A failing diagram yields `{ error: true }` and
 * does not stop the others; the function never rejects.
 */
export async function renderAll(
  sources: string[],
  renderer: MermaidRenderer,
  idPrefix: string,
): Promise<MermaidResult[]> {
  const results: MermaidResult[] = []
  for (let i = 0; i < sources.length; i++) {
    try {
      const { svg } = await renderer.render(`${idPrefix}-${i}`, sources[i] ?? '')
      results.push({ svg })
    } catch {
      results.push({ error: true })
    }
  }
  return results
}

/**
 * Loads mermaid on demand (dynamic import → its own chunk) and configures it.
 * `securityLevel: 'strict'` keeps click handlers and HTML labels out and runs
 * the output through mermaid's DOMPurify.
 */
export async function loadMermaid(theme: MermaidTheme): Promise<MermaidRenderer> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
  return { render: (id, src) => mermaid.render(id, src) }
}
