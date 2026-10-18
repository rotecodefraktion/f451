import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  ArchiveRejectedError,
  F451Api,
  collectExistingNames,
  folderSource,
  httpConverter,
  loadHtmlTree,
  loadMarkdownFolderTree,
  loadObsidianTree,
  loadOfficeTree,
  localConverter,
  zipSource,
  type FileSource,
  type ImportTree,
} from '@f451/import'
import { UsageError, type ParsedArgs } from './args.js'
import { writeTreeAndReport } from './import-bookstack.js'

/** A path ending in `.zip` is read as an archive, a directory as a folder; for
 *  `office`, any other file is a source of exactly that one file. */
async function openSource(path: string, single: boolean): Promise<FileSource> {
  if (single && !path.toLowerCase().endsWith('.zip') && (await stat(path)).isFile()) {
    const name = basename(path)
    return {
      list: async () => [name],
      read: async (p) => {
        if (p !== name) throw new Error(`not in the source: ${p}`)
        return readFile(path)
      },
    }
  }
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
  const src = await openSource(args.path, args.source === 'office')
  let tree: ImportTree
  if (args.source === 'office') {
    const url = args.convertUrl ?? env.F451_CONVERT_URL
    // An own ID continues the counter of the target space.
    const existing =
      args.text?.mainName === 'id' ? await collectExistingNames(f451, args.space, args.parent) : undefined
    tree = await loadOfficeTree(src, {
      converter: url ? httpConverter(url) : localConverter(),
      split: args.split === true,
      ...(args.text ? { text: args.text } : {}),
      ...(existing ?? {}),
      onFile: (path, i, total) => out.write(`Converting ${path} (${i + 1}/${total})\n`),
    })
  } else {
    tree =
      args.source === 'obsidian'
        ? await loadObsidianTree(src)
        : args.source === 'html'
          ? await loadHtmlTree(src)
          : await loadMarkdownFolderTree(src)
  }
  return writeTreeAndReport(tree, args, f451, out)
}
