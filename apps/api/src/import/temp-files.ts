import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Temp files of import uploads (`os.tmpdir()/f451-import-<uuid>.zip`).
 *
 * Each file is removed when its request fails or its job ends; whatever is
 * still listed at app shutdown (e.g. a job that outlived the shutdown wait) is
 * removed by `removeAll`.
 */
export class TempFiles {
  private readonly paths = new Set<string>()

  constructor(private readonly dir: string = tmpdir()) {}

  /** Reserves a new path; the file itself is created by the caller. */
  create(): string {
    const path = join(this.dir, `f451-import-${randomUUID()}.zip`)
    this.paths.add(path)
    return path
  }

  /** Never throws: a leftover temp file must not fail an import. */
  async remove(path: string): Promise<void> {
    this.paths.delete(path)
    await rm(path, { force: true }).catch(() => undefined)
  }

  async removeAll(): Promise<void> {
    await Promise.all([...this.paths].map((p) => this.remove(p)))
  }
}
