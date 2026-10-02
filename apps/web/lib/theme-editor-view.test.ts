import { AA_THRESHOLDS, DEFAULT_THRESHOLDS, checkContrast, resolveTheme } from '@f451/design-tokens'
import { describe, expect, it } from 'vitest'
import { assess, buildGroups, setValue, type EditorData } from './theme-editor.js'
import {
  describeSaveFailure,
  editorApiPath,
  firstRows,
  joinLength,
  pickScope,
  pickerValue,
  rowId,
  scopeParam,
  splitLength,
  themeApiPath,
  thresholdField,
  tokenStates,
  type ThemeScopes,
} from './theme-editor-view.js'

const scopes: ThemeScopes = {
  instance: { available: true, canWrite: false },
  spaces: [
    { id: 'betrieb', name: 'Betrieb', canWrite: true },
    { id: 'a b', name: 'A B', canWrite: false },
  ],
}
const noInstance: ThemeScopes = { ...scopes, instance: { available: false, canWrite: false } }

describe('pickScope', () => {
  it('takes a known scope from the query', () => {
    expect(pickScope('instance', scopes)).toEqual({ kind: 'instance' })
    expect(pickScope('space:betrieb', scopes)).toEqual({ kind: 'space', id: 'betrieb' })
    expect(pickScope(['space:a b', 'instance'], scopes)).toEqual({ kind: 'space', id: 'a b' })
  })

  it('falls back to the instance, then to the first space', () => {
    expect(pickScope(undefined, scopes)).toEqual({ kind: 'instance' })
    expect(pickScope('space:unknown', scopes)).toEqual({ kind: 'instance' })
    expect(pickScope('instance', noInstance)).toEqual({ kind: 'space', id: 'betrieb' })
    expect(pickScope('nonsense', noInstance)).toEqual({ kind: 'space', id: 'betrieb' })
  })

  it('is null when nothing is readable', () => {
    expect(pickScope(undefined, { instance: { available: false, canWrite: false }, spaces: [] })).toBeNull()
  })
})

describe('scope paths', () => {
  it('round-trips the query value and builds the API paths', () => {
    expect(scopeParam({ kind: 'instance' })).toBe('instance')
    expect(scopeParam({ kind: 'space', id: 'betrieb', name: 'Betrieb' })).toBe('space:betrieb')
    expect(pickScope(scopeParam({ kind: 'space', id: 'a b' }), scopes)).toEqual({ kind: 'space', id: 'a b' })
    expect(editorApiPath({ kind: 'instance' })).toBe('/api/theme/editor?scope=instance')
    expect(editorApiPath({ kind: 'space', id: 'a b' })).toBe('/api/theme/editor?scope=space&space=a%20b')
    expect(themeApiPath({ kind: 'instance' })).toBe('/api/theme')
    expect(themeApiPath({ kind: 'space', id: 'a b' })).toBe('/api/spaces/a%20b/theme')
  })
})

describe('field helpers', () => {
  it('offers the picker for #rrggbb only', () => {
    expect(pickerValue('#A1B2C3')).toBe('#a1b2c3')
    expect(pickerValue('#abc')).toBeNull()
    expect(pickerValue('#a1b2c3ff')).toBeNull()
    expect(pickerValue('color-mix(in srgb, red 10%, white)')).toBeNull()
  })

  it('splits and joins lengths within the allowed units', () => {
    expect(splitLength('68ch', ['ch'])).toEqual({ amount: '68', unit: 'ch' })
    expect(splitLength('.5rem', ['px', 'rem'])).toEqual({ amount: '.5', unit: 'rem' })
    expect(splitLength('0', ['px', 'rem'])).toEqual({ amount: '0', unit: 'px' })
    expect(splitLength('12px', ['rem'])).toBeNull()
    expect(splitLength('clamp(1rem, 1rem + 1vw, 2rem)', ['rem'])).toBeNull()
    expect(joinLength(' 70 ', 'ch')).toBe('70ch')
  })

  it('maps contrast roles to threshold fields', () => {
    expect(thresholdField('Lesetext')).toBe('readingText')
    expect(thresholdField('beiläufige Beschriftung')).toBe('incidental')
  })

  it('derives row ids without the dashes', () => {
    expect(rowId('--color-accent')).toBe('te-row-color-accent')
  })
})

function editorData(): EditorData {
  const below = resolveTheme([])
  return {
    scope: { kind: 'instance' },
    canWrite: true,
    file: null,
    problems: [],
    belowLayers: [],
    below,
    resolved: below,
    thresholds: DEFAULT_THRESHOLDS,
    defaults: DEFAULT_THRESHOLDS,
    aa: AA_THRESHOLDS,
    thresholdsSource: 'default',
    note: null,
    findings: checkContrast(below),
    rules: [],
  }
}

describe('tokenStates and firstRows', () => {
  it('finds no error in the default theme, but the known AA warnings', () => {
    const data = editorData()
    const a = assess(data, {})
    const states = tokenStates(a)
    expect(states.errors.size).toBe(0)
    expect(states.warnings.size).toBeGreaterThan(0)
    const jump = firstRows(buildGroups(data, {}), states)
    expect(jump.error).toBeNull()
    expect(jump.warning).not.toBeNull()
  })

  it('marks a pale accent as error and jumps to its row', () => {
    const data = editorData()
    const draft = setValue({}, 'color-accent', 'light', '#dddddd')
    const states = tokenStates(assess(data, draft))
    expect(states.errors.has('--color-accent')).toBe(true)
    expect(states.warnings.has('--color-accent')).toBe(false)
    expect(firstRows(buildGroups(data, draft), states).error).toEqual({ token: '--color-accent', group: 'Grundfarben' })
  })

  it('counts rule violations and parse errors as errors', () => {
    const data = editorData()
    expect(tokenStates(assess(data, setValue({}, 'weight-strong', 'base', '450'))).errors.has('--weight-strong')).toBe(true)
    expect(tokenStates(assess(data, setValue({}, 'color-accent', 'light', 'red'))).errors.has('--color-accent')).toBe(true)
  })
})

describe('describeSaveFailure', () => {
  it('reads the 422 bodies', () => {
    expect(
      describeSaveFailure(422, { status: 'invalid', errors: [{ code: 'value_invalid', path: 'light', message: 'bad' }] }),
    ).toEqual({ kind: 'invalid', messages: ['bad'] })
    expect(describeSaveFailure(422, { status: 'invalid', rules: [{ rule: 'weight-gap', message: 'gap', tokens: [] }] })).toEqual({
      kind: 'invalid',
      messages: ['gap'],
    })
    expect(
      describeSaveFailure(422, {
        status: 'contrast',
        contrast: [{ mode: 'light', ratio: 3.1, threshold: 4.5, pair: { was: 'Fließtext auf Papier' } }, { nonsense: true }],
      }),
    ).toEqual({ kind: 'contrast', items: [{ what: 'Fließtext auf Papier', mode: 'light', ratio: 3.1, threshold: 4.5 }] })
  })

  it('maps the other statuses', () => {
    expect(describeSaveFailure(403, { error: 'x' })).toEqual({ kind: 'forbidden' })
    expect(describeSaveFailure(404, null)).toEqual({ kind: 'notFound' })
    expect(describeSaveFailure(409, null)).toEqual({ kind: 'conflict' })
    expect(describeSaveFailure(502, { status: 'error' })).toEqual({ kind: 'error' })
    expect(describeSaveFailure(422, 'garbage')).toEqual({ kind: 'error' })
  })
})
