import { describe, expect, it } from 'vitest'
import { matchYoutubeParagraph, youtubeVideoId } from '../src/youtube.js'

const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const SHORT = 'https://youtu.be/dQw4w9WgXcQ'

function autolinkParagraph(url: string) {
  return { type: 'paragraph', children: [{ type: 'link', url, title: null, children: [{ type: 'text', value: url }] }] }
}

describe('youtubeVideoId', () => {
  it('watch?v= und youtu.be, auch mit Zusatz-Parametern', () => {
    expect(youtubeVideoId(WATCH)).toBe('dQw4w9WgXcQ')
    expect(youtubeVideoId(SHORT)).toBe('dQw4w9WgXcQ')
    expect(youtubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ')
    expect(youtubeVideoId('http://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ')
  })
  it('lehnt Nicht-YouTube, falsche ID-Länge und javascript:-Tricks ab', () => {
    expect(youtubeVideoId('https://vimeo.com/12345')).toBeNull()
    expect(youtubeVideoId('https://www.youtube.com/watch?v=kurz')).toBeNull()
    expect(youtubeVideoId('javascript:alert(1)')).toBeNull()
    expect(youtubeVideoId('https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })
})

describe('matchYoutubeParagraph', () => {
  it('matcht den Allein-auf-Zeile-Autolink', () => {
    expect(matchYoutubeParagraph(autolinkParagraph(WATCH))).toEqual({ url: WATCH, videoId: 'dQw4w9WgXcQ' })
  })
  it('matcht NICHT: Text+Link, Link mit abweichendem Linktext, zwei Kinder, Nicht-YouTube', () => {
    expect(matchYoutubeParagraph({ type: 'paragraph', children: [{ type: 'text', value: 'Siehe ' } as never, ...autolinkParagraph(WATCH).children] })).toBeNull()
    expect(matchYoutubeParagraph({ type: 'paragraph', children: [{ type: 'link', url: WATCH, title: null, children: [{ type: 'text', value: 'Video' }] }] })).toBeNull()
    expect(matchYoutubeParagraph(autolinkParagraph('https://vimeo.com/1'))).toBeNull()
  })
})
