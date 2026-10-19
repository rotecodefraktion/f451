/**
 * Packs a folder chosen in the browser (`<input type="file" webkitdirectory>`)
 * into a ZIP for the file import (#176), so the panel can upload a Markdown
 * folder, an Obsidian vault or an HTML folder without the user zipping it
 * first. The API receives the same kind of archive as from "Choose ZIP".
 *
 * Paths in the ZIP are relative to the chosen folder: its own name (the first
 * segment of `webkitRelativePath`) becomes the archive name, not a directory
 * level inside it.
 */
import { zip, type AsyncZippable } from 'fflate'

/** The part of a `File` that {@link folderEntries} reads. */
export interface FolderFile {
  webkitRelativePath: string
  name: string
}

export interface FolderEntries {
  /** Name of the chosen folder; empty if no file carried a relative path. */
  root: string
  /** Kept files: path inside the ZIP and index into the input list. */
  entries: { path: string; index: number }[]
}

/**
 * Which files of a folder pick go into the ZIP, and under which path. Drops
 * everything under a `.git` segment and macOS `.DS_Store` files; other
 * dotfolders stay (Obsidian keeps its settings in `.obsidian/`). Files
 * without a folder segment (not from a folder pick) are skipped.
 */
export function folderEntries(files: readonly FolderFile[]): FolderEntries {
  let root = ''
  const entries: FolderEntries['entries'] = []
  files.forEach((file, index) => {
    const segments = file.webkitRelativePath.split('/').filter((s) => s !== '')
    if (segments.length < 2) return
    if (!root) root = segments[0]!
    const rest = segments.slice(1)
    if (rest.includes('.git')) return
    if (file.name === '.DS_Store' || rest[rest.length - 1] === '.DS_Store') return
    entries.push({ path: rest.join('/'), index })
  })
  return { root, entries }
}

export interface PackedFolder {
  blob: Blob
  /** `<root>.zip` */
  name: string
  /** Number of files in the ZIP. */
  count: number
  /** Total size of those files before compression. */
  bytes: number
}

/** Reads the kept files of a folder pick and packs them into a ZIP (level 6). */
export async function zipFolder(files: File[]): Promise<PackedFolder> {
  const { root, entries } = folderEntries(files)
  const data: AsyncZippable = {}
  let bytes = 0
  for (const entry of entries) {
    const file = files[entry.index]!
    data[entry.path] = new Uint8Array(await file.arrayBuffer())
    bytes += file.size
  }
  const packed = await new Promise<Uint8Array>((resolve, reject) => {
    zip(data, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  // Copy into a plain ArrayBuffer: newer DOM typings reject a view over `ArrayBufferLike` as a BlobPart.
  const buffer = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer
  return {
    blob: new Blob([buffer], { type: 'application/zip' }),
    name: `${root || 'folder'}.zip`,
    count: entries.length,
    bytes,
  }
}

/** Short size for the status line: `512 B`, `27 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
