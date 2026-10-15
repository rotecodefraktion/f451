import { describe, expect, it, vi } from 'vitest'
import { mermaidTheme, renderAll, type MermaidRenderer } from './mermaid'

describe('mermaidTheme', () => {
  it('follows an explicit dark choice regardless of the system', () => {
    expect(mermaidTheme('dark', false)).toBe('dark')
    expect(mermaidTheme('dark', true)).toBe('dark')
  })

  it('follows an explicit light choice regardless of the system', () => {
    expect(mermaidTheme('light', false)).toBe('default')
    expect(mermaidTheme('light', true)).toBe('default')
  })

  it('falls back to the system preference without a choice', () => {
    expect(mermaidTheme(undefined, true)).toBe('dark')
    expect(mermaidTheme(undefined, false)).toBe('default')
  })
})

function stub(fail: (source: string) => boolean = () => false) {
  const render = vi.fn(async (id: string, source: string) => {
    if (fail(source)) throw new Error('parse error')
    return { svg: `<svg data-id="${id}">${source}</svg>` }
  })
  const renderer: MermaidRenderer = { render }
  return { renderer, render }
}

describe('renderAll', () => {
  it('renders every source in order', async () => {
    const { renderer } = stub()
    const results = await renderAll(['a', 'b'], renderer, 'm')
    expect(results).toEqual([
      { svg: '<svg data-id="m-0">a</svg>' },
      { svg: '<svg data-id="m-1">b</svg>' },
    ])
  })

  it('isolates a failing diagram and keeps the order', async () => {
    const { renderer } = stub((s) => s === 'bad')
    const results = await renderAll(['a', 'bad', 'c'], renderer, 'm')
    expect(results).toEqual([
      { svg: '<svg data-id="m-0">a</svg>' },
      { error: true },
      { svg: '<svg data-id="m-2">c</svg>' },
    ])
  })

  it('does not call the renderer for an empty list', async () => {
    const { renderer, render } = stub()
    expect(await renderAll([], renderer, 'm')).toEqual([])
    expect(render).not.toHaveBeenCalled()
  })

  it('builds ids from the prefix and the index', async () => {
    const { renderer, render } = stub()
    await renderAll(['x', 'y'], renderer, 'pb-r1')
    expect(render.mock.calls.map((c) => c[0])).toEqual(['pb-r1-0', 'pb-r1-1'])
  })
})
