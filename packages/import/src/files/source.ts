/** A read-only set of files: a folder on disk or a ZIP archive. */
export interface FileSource {
  /** Relative POSIX paths of all regular files, sorted. */
  list(): Promise<string[]>
  /** Content of a file returned by `list()`; any other path is refused. */
  read(path: string): Promise<Uint8Array>
}

/** Limits that keep a ZIP archive from exhausting memory (zip bomb). */
export interface ZipLimits {
  /** Maximum number of entries in the central directory, directories included. */
  maxEntries: number
  /** Maximum ratio of total uncompressed size to archive size. */
  maxRatio: number
  /** Maximum total uncompressed size in bytes. */
  maxUnpackedBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxRatio: 10,
  maxUnpackedBytes: 2 * 1024 ** 3,
}

/** The archive as a whole is refused; `message` is the reason shown to the user. */
export class ArchiveRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveRejectedError'
  }
}

/** Code-unit order, independent of locale, so listings are deterministic. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
