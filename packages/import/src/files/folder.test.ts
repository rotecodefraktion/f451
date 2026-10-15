import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderSource } from './folder.js'

let base: string
let dir: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'f451-folder-source-'))
  dir = join(base, 'vault')
  await mkdir(join(dir, 'Notes', 'Deep'), { recursive: true })
  await writeFile(join(dir, 'b.md'), '# B')
  await writeFile(join(dir, 'Notes', 'a.md'), '# A')
  await writeFile(join(dir, 'Notes', 'Deep', 'c.md'), '# C')
  await mkdir(join(dir, 'empty'))
  await writeFile(join(base, 'outside.md'), 'secret')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('folderSource', () => {
  it('lists regular files as sorted POSIX paths and reads them', async () => {
    const src = folderSource(dir)
    expect(await src.list()).toEqual(['Notes/Deep/c.md', 'Notes/a.md', 'b.md'])
    expect(new TextDecoder().decode(await src.read('Notes/Deep/c.md'))).toBe('# C')
  })

  it('skips symlinks to files and directories', async () => {
    await symlink(join(base, 'outside.md'), join(dir, 'link.md'))
    await symlink(base, join(dir, 'up'), 'dir')
    const src = folderSource(dir)
    expect(await src.list()).toEqual(['Notes/Deep/c.md', 'Notes/a.md', 'b.md'])
    await expect(src.read('link.md')).rejects.toThrow()
    await expect(src.read('up/outside.md')).rejects.toThrow()
  })

  it('refuses paths outside the listing', async () => {
    const src = folderSource(dir)
    await expect(src.read('../outside.md')).rejects.toThrow()
    await expect(src.read(join(base, 'outside.md'))).rejects.toThrow()
    await expect(src.read('Notes')).rejects.toThrow()
  })
})
