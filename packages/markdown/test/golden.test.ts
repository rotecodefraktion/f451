import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePage } from '../src/parse.js'
import { renderHtml } from '../src/render.js'

const md = readFileSync(new URL('./fixtures/beispielseite.md', import.meta.url), 'utf8')
const opts = {
  resolveLink: (t: string) =>
    t.includes('fehlt') ? null : { href: `/pages/${t.toLowerCase().replaceAll('/', '--')}` },
  resolveImage: (s: string) => `/media/demo/${s.replace('_media/', '')}`,
}

describe('Golden-Files', () => {
  it('parsePage entspricht beispielseite.parsed.json', () => {
    const expected = JSON.parse(
      readFileSync(new URL('./fixtures/beispielseite.parsed.json', import.meta.url), 'utf8'),
    )
    expect(JSON.parse(JSON.stringify(parsePage(md)))).toEqual(expected)
  })

  it('renderHtml entspricht beispielseite.html', () => {
    const expected = readFileSync(new URL('./fixtures/beispielseite.html', import.meta.url), 'utf8')
    expect(renderHtml(md, opts).trim()).toBe(expected.trim())
  })
})
