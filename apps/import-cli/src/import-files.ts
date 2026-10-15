import { readFile } from 'node:fs/promises'
import {
  ArchiveRejectedError,
  F451Api,
  folderSource,
  loadHtmlTree,
  loadMarkdownFolderTree,
  loadObsidianTree,
  zipSource,
  type FileSource,
} from '@f451/import'
import { UsageError, type ParsedArgs } from './args.js'
import { writeTreeAndReport } from './import-bookstack.js'

/** A path ending in `.zip` is read as an archive, anything else as a folder. */
async function openSource(path: string): Promise<FileSource> {
  if (!path.toLowerCase().endsWith('.zip')) return folderSource(path)
  try {
    return zipSource(await readFile(path))
  } catch (e) {
    if (e instanceof ArchiveRejectedError) throw new Error(`archive rejected: ${path}: ${e.message}`)
    throw e
  }
}

export async function runFileImport(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WriteStream,
): Promise<number> {
  const need = (k: string) => {
    const v = env[k]
    if (!v) throw new UsageError(`${k} is not set`)
    return v
  }
  if (!args.path) throw new UsageError('missing path')
  const f451 = new F451Api(need('F451_URL'), need('F451_TOKEN'))
  const src = await openSource(args.path)
  const tree =
    args.source === 'obsidian'
      ? await loadObsidianTree(src)
      : args.source === 'html'
        ? await loadHtmlTree(src)
        : await loadMarkdownFolderTree(src)
  return writeTreeAndReport(tree, args, f451, out)
}
