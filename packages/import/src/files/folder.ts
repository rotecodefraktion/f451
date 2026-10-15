import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { comparePaths, type FileSource } from './source.js'

/**
 * A folder on disk as a file source. Symlinks are skipped (files and directories alike),
 * so the walk never leaves `dir`; `read` only serves paths that `list` returned.
 */
export function folderSource(dir: string): FileSource {
  let listing: Promise<{ sorted: string[]; known: Set<string> }> | undefined
  const scan = () =>
    (listing ??= walk(dir, '').then((paths) => ({ sorted: paths.sort(comparePaths), known: new Set(paths) })))
  return {
    async list() {
      return [...(await scan()).sorted]
    },
    async read(path) {
      if (!(await scan()).known.has(path)) throw new Error(`Not a file in the folder: ${path}`)
      return new Uint8Array(await readFile(join(dir, ...path.split('/'))))
    },
  }
}

async function walk(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(root, path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}
