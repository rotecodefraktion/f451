import { describe, expect, it } from 'vitest'
import { youtubeEmbedSrc } from './youtube.js'

describe('youtubeEmbedSrc', () => {
  it('baut die nocookie-URL für eine gültige ID', () => {
    expect(youtubeEmbedSrc('dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1')
  })
  it('lehnt alles ab, was keine 11-Zeichen-ID ist', () => {
    expect(youtubeEmbedSrc('')).toBeNull()
    expect(youtubeEmbedSrc('zu-kurz')).toBeNull()
    expect(youtubeEmbedSrc('dQw4w9WgXcQ"><script>')).toBeNull()
    expect(youtubeEmbedSrc('../../etc/pwd')).toBeNull()
  })
})
