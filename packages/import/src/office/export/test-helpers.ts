// Shared fixtures for the Office export tests (not exported from the package).

import type { TreeNode } from '../../api.js'
import { pageResolver } from '../../export/bookstack/html.js'
import { xmlEvents } from '../xml.js'
import type { ExportContext } from './links.js'
import type { ExportPageSource } from './load.js'

export const node = (id: string, title: string, children: TreeNode[] = [], archived = false): TreeNode => ({
  id,
  title,
  path: `${id}/index.md`,
  archived,
  children,
})

export const page = (
  id: string,
  title: string,
  depth: number,
  markdown: string,
  media: Record<string, Uint8Array> = {},
): ExportPageSource => ({ id, title, depth, markdown, media: new Map(Object.entries(media)) })

export function context(roots: TreeNode[], rasterDiagrams = false): ExportContext {
  return { space: 'space', publicBaseUrl: 'https://wiki.example/', resolvePage: pageResolver(roots), rasterDiagrams }
}

/** A PNG header (signature + IHDR) of the given size; enough for size sniffing. */
export function pngHeader(width: number, height: number, fill = 0): Uint8Array {
  const bytes = new Uint8Array(33).fill(fill)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** Balanced tags with a single root; returns the root element name. Throws otherwise. */
export function wellFormedRoot(xml: string): string {
  const stack: string[] = []
  let root: string | null = null
  for (const e of xmlEvents(xml)) {
    if (e.type === 'open') {
      if (stack.length === 0) {
        if (root !== null) throw new Error(`second root <${e.name}>`)
        root = e.name
      }
      if (!e.selfClosing) stack.push(e.name)
    } else if (e.type === 'close') {
      const top = stack.pop()
      if (top !== e.name) throw new Error(`</${e.name}> closes <${top}>`)
    } else if (stack.length === 0 && e.value.trim()) {
      throw new Error('text outside the root')
    }
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack.join('>, <')}>`)
  if (root === null) throw new Error('no root')
  // Raw `<` or `&` that are not markup would have been skipped by the tokenizer.
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(xml)) throw new Error('unescaped &')
  return root
}
