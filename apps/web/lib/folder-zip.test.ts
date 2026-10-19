import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { folderEntries, formatSize, zipFolder } from './folder-zip'

/** A `File` as a folder pick delivers it: `webkitRelativePath` set. */
function picked(path: string, content: string): File {
  const name = path.split('/').pop()!
  const file = new File([content], name)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

const PATHS = [
  'notes/a.md',
  'notes/sub/b.md',
  'notes/img/x.png',
  'notes/.git/HEAD',
  'notes/.DS_Store',
  'notes/.obsidian/app.json',
]

describe('folderEntries', () => {
  it('strips the folder name, drops .git and .DS_Store, keeps other dotfolders', () => {
    const files = PATHS.map((p) => ({ webkitRelativePath: p, name: p.split('/').pop()! }))
    expect(folderEntries(files)).toEqual({
      root: 'notes',
      entries: [
        { path: 'a.md', index: 0 },
        { path: 'sub/b.md', index: 1 },
        { path: 'img/x.png', index: 2 },
        { path: '.obsidian/app.json', index: 5 },
      ],
    })
  })

  it('drops .DS_Store in subfolders and anything deeper under .git', () => {
    const files = ['notes/sub/.DS_Store', 'notes/.git/refs/heads/main', 'notes/c.md'].map((p) => ({
      webkitRelativePath: p,
      name: p.split('/').pop()!,
    }))
    expect(folderEntries(files)).toEqual({ root: 'notes', entries: [{ path: 'c.md', index: 2 }] })
  })

  it('skips files without a folder segment', () => {
    expect(folderEntries([{ webkitRelativePath: '', name: 'loose.md' }])).toEqual({ root: '', entries: [] })
  })
})

describe('zipFolder', () => {
  it('packs the kept files with paths relative to the chosen folder', async () => {
    const files = PATHS.map((p) => picked(p, `content of ${p}`))
    const packed = await zipFolder(files)
    expect(packed.name).toBe('notes.zip')
    expect(packed.count).toBe(4)
    expect(packed.blob.type).toBe('application/zip')
    const kept = ['notes/a.md', 'notes/sub/b.md', 'notes/img/x.png', 'notes/.obsidian/app.json']
    expect(packed.bytes).toBe(kept.reduce((sum, p) => sum + `content of ${p}`.length, 0))

    const unzipped = unzipSync(new Uint8Array(await packed.blob.arrayBuffer()))
    expect(Object.keys(unzipped).sort()).toEqual(['.obsidian/app.json', 'a.md', 'img/x.png', 'sub/b.md'])
    expect(strFromU8(unzipped['sub/b.md']!)).toBe('content of notes/sub/b.md')
    expect(strFromU8(unzipped['.obsidian/app.json']!)).toBe('content of notes/.obsidian/app.json')
  })
})

describe('formatSize', () => {
  it('uses B, KB and MB', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(27 * 1024)).toBe('27 KB')
    expect(formatSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
  })
})
