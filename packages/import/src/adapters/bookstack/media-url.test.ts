import { describe, expect, it } from 'vitest'
import { bookStackMediaUrl } from './media.js'

describe('bookStackMediaUrl', () => {
  it('resolves relative media paths against the base URL', () => {
    expect(bookStackMediaUrl('/uploads/images/a.png', 'https://bs.example')).toBe('https://bs.example/uploads/images/a.png')
  })
  it('fetches media named under another host from the base URL', () => {
    expect(bookStackMediaUrl('http://localhost:6875/uploads/images/a.png?v=2', 'http://bookstack:80')).toBe(
      'http://bookstack:80/uploads/images/a.png?v=2',
    )
  })
  it('keeps a path prefix of the base URL', () => {
    expect(bookStackMediaUrl('https://public.example/wiki/uploads/a.png', 'https://bs.internal/wiki')).toBe(
      'https://bs.internal/wiki/uploads/a.png',
    )
    expect(bookStackMediaUrl('/wiki/uploads/a.png', 'https://bs.internal/wiki')).toBe('https://bs.internal/wiki/uploads/a.png')
  })
  it('ignores images that are not BookStack media', () => {
    expect(bookStackMediaUrl('https://example.org/logo.png', 'https://bs.example')).toBeNull()
    expect(bookStackMediaUrl('data:image/png;base64,AAAA', 'https://bs.example')).toBeNull()
  })
})
