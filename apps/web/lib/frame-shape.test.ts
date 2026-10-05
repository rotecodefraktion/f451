import { describe, expect, it } from 'vitest'
import { frameShape } from './frame-shape.js'

const EDITORIAL = { topbar: false, pageHead: 'title', paneControls: 'edges', statusBar: false }

describe('frameShape', () => {
  it('missing switches → Editorial defaults', () => {
    expect(frameShape(undefined, { hasTree: true })).toEqual(EDITORIAL)
    expect(frameShape({}, { hasTree: true })).toEqual(EDITORIAL)
  })

  it('unknown values → Editorial defaults', () => {
    const switches = { topbar: 'maybe', 'page-head': 'banner', 'pane-controls': 'corner', 'status-bar': 'top' }
    expect(frameShape(switches, { hasTree: true })).toEqual(EDITORIAL)
  })

  it('reads every known value', () => {
    const switches = { topbar: 'on', 'page-head': 'toolbar', 'pane-controls': 'topbar', 'status-bar': 'bottom' }
    expect(frameShape(switches, { hasTree: true })).toEqual({
      topbar: true,
      pageHead: 'toolbar',
      paneControls: 'topbar',
      statusBar: true,
    })
  })

  it('pane-controls: topbar with topbar: off falls back to the edge grips (Review Focus 1)', () => {
    const shape = frameShape({ topbar: 'off', 'pane-controls': 'topbar' }, { hasTree: true })
    expect(shape.topbar).toBe(false)
    expect(shape.paneControls).toBe('edges')
  })

  it('pane-controls: topbar with topbar missing falls back to the edge grips', () => {
    expect(frameShape({ 'pane-controls': 'topbar' }, { hasTree: true }).paneControls).toBe('edges')
  })

  it('a page without a tree keeps the top bar and the edge grips (Review Focus 4)', () => {
    expect(frameShape({ topbar: 'off' }, { hasTree: false })).toMatchObject({ topbar: true, paneControls: 'edges' })
    expect(frameShape(undefined, { hasTree: false })).toMatchObject({ topbar: true, paneControls: 'edges' })
    expect(
      frameShape({ topbar: 'on', 'pane-controls': 'topbar' }, { hasTree: false }),
    ).toMatchObject({ topbar: true, paneControls: 'edges' })
  })

  it('a page without a tree still follows page-head and status-bar', () => {
    expect(frameShape({ 'page-head': 'toolbar', 'status-bar': 'bottom' }, { hasTree: false })).toMatchObject({
      pageHead: 'toolbar',
      statusBar: true,
    })
  })
})
