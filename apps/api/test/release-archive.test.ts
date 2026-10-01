import { describe, expect, it } from 'vitest'
import { parsePage } from '@f451/markdown'
import {
  isReleasePath,
  pageDir,
  referencedMedia,
  releaseCopyContent,
  releaseDir,
} from '../src/drafts/release-archive.js'

describe('release archive helpers (#38)', () => {
  it('places the copy next to the page', () => {
    expect(releaseDir('ops/backup/index.md', '1.2.0')).toBe('ops/backup/_releases/1.2.0')
    expect(releaseDir('index.md', '1.0.0')).toBe('_releases/1.0.0')
    expect(pageDir('index.md')).toBe('')
  })

  it('recognises release paths', () => {
    expect(isReleasePath('ops/_releases/1.0.0/page.md')).toBe(true)
    expect(isReleasePath('ops/_media/releases.png')).toBe(false)
  })

  it('copy keeps content and version, drops id, adds release stamp', () => {
    const page = '---\nid: p-1\ntitle: Backup\nversion: 1.2.0\n---\n# Backup\n\nText\n'
    const copy = releaseCopyContent(page, { version: '1.2.0', date: '2026-10-01', by: 'Jane', source: 'p-1' })
    const parsed = parsePage(copy)
    expect(parsed.frontmatter.id).toBeUndefined()
    expect(parsed.frontmatter.title).toBe('Backup')
    expect(parsed.frontmatter.version).toBe('1.2.0')
    expect(parsed.frontmatter.metadata?.release).toEqual({ version: '1.2.0', date: '2026-10-01', by: 'Jane', source: 'p-1' })
    expect(copy).toContain('Text')
  })

  it('copies only referenced attachments', () => {
    const md = '![a](_media/net.drawio.svg) ![b](./_media/My%20Shot.png)'
    expect(referencedMedia(md, ['net.drawio.svg', 'My Shot.png', 'old.png'])).toEqual(['net.drawio.svg', 'My Shot.png'])
  })
})
