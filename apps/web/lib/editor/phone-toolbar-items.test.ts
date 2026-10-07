import { describe, expect, it } from 'vitest'
import { moreSheetItems, nextHeadingLevel, PHONE_TOOLBAR } from './phone-toolbar-items.js'
import { t as translate } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import type { T } from '../i18n/types.js'

const t: T = (key, params) => translate(de, key, params)

describe('PHONE_TOOLBAR', () => {
  it('lists the bar buttons in order', () => {
    expect(PHONE_TOOLBAR).toEqual([
      'heading',
      'bold',
      'code',
      'link',
      'bulletList',
      'orderedList',
      'image',
      'undo',
      'more',
    ])
  })
})

describe('nextHeadingLevel', () => {
  it.each([
    [0, 2],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 0],
    [5, 0],
    [6, 0],
  ] as const)('%i → %i', (current, next) => {
    expect(nextHeadingLevel(current)).toBe(next)
  })
})

describe('moreSheetItems', () => {
  const ids = moreSheetItems(t).map((item) => item.id)

  it('offers the remaining block formats', () => {
    for (const id of [
      'taskList',
      'table',
      'codeBlock',
      'blockquote',
      'alertNote',
      'alertTip',
      'alertImportant',
      'alertWarning',
      'alertCaution',
      'horizontalRule',
      'footnote',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('leaves out the diagram items (phone layout)', () => {
    expect(ids).not.toContain('drawio')
    expect(ids).not.toContain('excalidraw')
  })

  it('leaves out what the bar already offers', () => {
    for (const id of ['heading1', 'heading2', 'heading3', 'bulletList', 'orderedList', 'image']) {
      expect(ids).not.toContain(id)
    }
  })
})
