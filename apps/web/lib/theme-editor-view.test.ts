import { AA_THRESHOLDS, DEFAULT_THRESHOLDS, checkContrast, resolveTheme } from '@f451/design-tokens'
import { describe, expect, it } from 'vitest'
import { leseUeberschreibungen } from './erscheinungsbild.js'
import { assess, buildGroups, setValue, type EditorData } from './theme-editor.js'
import {
  describeSaveFailure,
  editorApiPath,
  firstRows,
  joinLength,
  overridesToThemeFile,
  pickScope,
  pickerValue,
  rowId,
  scopeParam,
  serverWarningCount,
  splitLength,
  themeApiPath,
  thresholdField,
  tokenStates,
  type ThemeScopes,
} from './theme-editor-view.js'

const scopes: ThemeScopes = {
  user: { available: false },
  instance: { available: true, canWrite: false },
  spaces: [
    { id: 'betrieb', name: 'Betrieb', canWrite: true },
    { id: 'a b', name: 'A B', canWrite: false },
  ],
}
const noInstance: ThemeScopes = { ...scopes, instance: { available: false, canWrite: false } }
const withUser: ThemeScopes = { ...scopes, user: { available: true } }

describe('pickScope', () => {
  it('opens the user scope by default when it is available', () => {
    expect(pickScope(undefined, withUser)).toEqual({ kind: 'user' })
    expect(pickScope('user', withUser)).toEqual({ kind: 'user' })
    expect(pickScope('nonsense', withUser)).toEqual({ kind: 'user' })
    expect(pickScope('instance', withUser)).toEqual({ kind: 'instance' })
    expect(pickScope('space:betrieb', withUser)).toEqual({ kind: 'space', id: 'betrieb' })
  })

  it('ignores ?scope=user when the user scope is not available', () => {
    expect(pickScope('user', scopes)).toEqual({ kind: 'instance' })
  })

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
    expect(
      pickScope(undefined, { user: { available: false }, instance: { available: false, canWrite: false }, spaces: [] }),
    ).toBeNull()
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

  it('knows the user scope', () => {
    expect(scopeParam({ kind: 'user' })).toBe('user')
    expect(pickScope(scopeParam({ kind: 'user' }), withUser)).toEqual({ kind: 'user' })
    expect(editorApiPath({ kind: 'user' })).toBe('/api/theme/editor?scope=user')
    expect(themeApiPath({ kind: 'user' })).toBe('/api/me/theme')
  })
})

describe('serverWarningCount', () => {
  it('counts the warnings of a PUT /api/me/theme answer', () => {
    expect(serverWarningCount({ file: {}, problems: [], warnings: [{}, {}] })).toBe(2)
    expect(serverWarningCount({ file: {} })).toBe(0)
    expect(serverWarningCount(null)).toBe(0)
  })
})

describe('overridesToThemeFile', () => {
  it('strips the dashes, keeps the mode and moves structure tokens to base', () => {
    const file = overridesToThemeFile({
      light: { '--color-accent': '#aa3300', '--measure': '70ch' },
      dark: { '--color-accent': '#ff8855', '--measure': '70ch' },
    })
    expect(file).toEqual({
      base: { measure: '70ch' },
      light: { 'color-accent': '#aa3300' },
      dark: { 'color-accent': '#ff8855' },
    })
  })

  it('drops unknown tokens and invalid values, and leaves empty sections out', () => {
    expect(
      overridesToThemeFile({ light: { '--no-such-token': '#000000', '--color-accent': 'red' }, dark: {} }),
    ).toEqual({})
  })

  it('reads what leseUeberschreibungen yields from an old stored value', () => {
    const raw = JSON.stringify({ light: { '--color-accent': '#0b5fa5' }, dark: {} })
    expect(overridesToThemeFile(leseUeberschreibungen(raw))).toEqual({ light: { 'color-accent': '#0b5fa5' } })
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
