import { describe, expect, it } from 'vitest'
import { strToU8, strFromU8, zipSync, type Zippable } from 'fflate'
import { zipSource } from './zip.js'
import { ArchiveRejectedError } from './source.js'

const text = (s: string) => strToU8(s)
const readText = async (src: ReturnType<typeof zipSource>, path: string) => strFromU8(await src.read(path))

describe('zipSource', () => {
  it('lists regular files sorted and reads them', async () => {
    const src = zipSource(zipSync({ 'b.md': text('# B'), 'Notes/a.md': text('# A'), 'img.png': new Uint8Array([1, 2, 3]) }))
    expect(await src.list()).toEqual(['Notes/a.md', 'b.md', 'img.png'])
    expect(await readText(src, 'Notes/a.md')).toBe('# A')
    expect(Array.from(await src.read('img.png'))).toEqual([1, 2, 3])
  })

  it('reads stored (uncompressed) entries', async () => {
    const src = zipSource(zipSync({ 'a.md': text('hello') }, { level: 0 }))
    expect(await readText(src, 'a.md')).toBe('hello')
  })

  it('refuses to read a path that is not listed', async () => {
    const src = zipSource(zipSync({ 'a.md': text('x') }))
    await expect(src.read('missing.md')).rejects.toThrow()
  })

  it('strips a single wrapper folder', async () => {
    const src = zipSource(zipSync({ 'Vault/': new Uint8Array(0), 'Vault/Notes/a.md': text('A'), 'Vault/b.md': text('B') }))
    expect(await src.list()).toEqual(['Notes/a.md', 'b.md'])
    expect(await readText(src, 'Notes/a.md')).toBe('A')
  })

  it('keeps the top level when files sit next to the folder', async () => {
    const src = zipSource(zipSync({ 'Vault/a.md': text('A'), 'root.md': text('R') }))
    expect(await src.list()).toEqual(['Vault/a.md', 'root.md'])
  })

  it('ignores __MACOSX metadata when looking for the wrapper folder', async () => {
    const src = zipSource(zipSync({ 'Vault/a.md': text('A'), '__MACOSX/Vault/._a.md': text('junk') }))
    expect(await src.list()).toEqual(['a.md'])
  })

  it('skips directory entries', async () => {
    const src = zipSource(zipSync({ 'empty/': new Uint8Array(0), 'a.md': text('A') }))
    expect(await src.list()).toEqual(['a.md'])
  })

  it('skips symlink entries', async () => {
    const files: Zippable = {
      'a.md': text('A'),
      'link.md': [text('/etc/passwd'), { os: 3, attrs: 0o120777 << 16 }],
    }
    const src = zipSource(zipSync(files))
    expect(await src.list()).toEqual(['a.md'])
    await expect(src.read('link.md')).rejects.toThrow()
  })

  it.each([
    ['../evil.md'],
    ['Notes/../../evil.md'],
    ['/etc/evil.md'],
    ['C:/evil.md'],
    ['Notes\\evil.md'],
  ])('rejects the archive for the unsafe path %s', (name) => {
    const bytes = zipSync({ 'ok.md': text('ok'), [name]: text('x') })
    expect(() => zipSource(bytes)).toThrow(ArchiveRejectedError)
  })

  it('rejects too many entries', () => {
    const bytes = zipSync({ 'a.md': text('a'), 'b.md': text('b'), 'c.md': text('c') })
    expect(() => zipSource(bytes, { maxEntries: 2 })).toThrow(/3 entries/)
  })

  it('rejects an archive that unpacks beyond the size limit', () => {
    const bytes = zipSync({ 'a.md': text('x'.repeat(100)) }, { level: 0 })
    expect(() => zipSource(bytes, { maxUnpackedBytes: 50 })).toThrow(ArchiveRejectedError)
  })

  it('rejects an archive whose unpacked size exceeds the ratio (zip bomb)', () => {
    const bytes = zipSync({ 'zeros.bin': new Uint8Array(1024 * 1024) })
    expect(() => zipSource(bytes)).toThrow(/times its own size/)
  })

  it('rejects data that is not a ZIP archive', () => {
    expect(() => zipSource(text('not a zip at all, just some text'))).toThrow(ArchiveRejectedError)
  })
})
