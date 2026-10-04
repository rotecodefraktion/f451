import { AA_THRESHOLDS, DEFAULT_THRESHOLDS, checkContrast, resolveTheme } from '@f451/design-tokens'
import { describe, expect, it } from 'vitest'
import { leseUeberschreibungen } from './erscheinungsbild.js'
import { assess, buildGroups, setValue, type EditorData } from './theme-editor.js'
import {
  brandAllowed,
  brandApiPath,
  brandImageUrl,
  CHOICE_VALUES,
  choiceLabel,
  describeBrandFailure,
  describeSaveFailure,
  editorApiPath,
  firstRows,
  joinLength,
  libraryApiPath,
  overridesToThemeFile,
  ownsTemplate,
  pickScope,
  pickerValue,
  rowId,
  scopeParam,
  serverWarningCount,
  slugFromName,
  splitLength,
  TEMPLATE_SLUG,
  templateOptions,
  themeApiPath,
  thresholdField,
  tokenStates,
  type ThemeScopes,
} from './theme-editor-view.js'
import type { LibraryEntry } from './theme-editor.js'

describe('choiceLabel', () => {
  // `lib/i18n/format.ts` answers a missing key with the marker ⟦key⟧ and never throws
  const t = (key: string) => (key === 'settings.appearance.choice.filled' ? 'gefüllt' : `⟦${key}⟧`)
  it('translates a known value and falls back to the raw value', () => {
    expect(choiceLabel(t, 'filled')).toBe('gefüllt')
    expect(choiceLabel(t, 'none')).toBe('none')
    expect(choiceLabel(t, 'boxed')).toBe('boxed')
  })
  it('lists every value of every switch', () => {
    expect(CHOICE_VALUES).toEqual(
      expect.arrayContaining(['bar', 'box', 'ink', 'accent', 'outline-caps', 'filled', 'marker', 'numeral', 'none', 'top', 'all', 'off', 'on', 'plain', 'cards', 'disc', 'dash']),
    )
  })
})

describe('templates', () => {
  it('derives a slug from a name', () => {
    expect(slugFromName('Ruhiges Blau')).toBe('ruhiges-blau')
    expect(slugFromName('  Größe & Übersicht!  ')).toBe('groesse-uebersicht')
    expect(slugFromName('Café Noir')).toBe('cafe-noir')
    expect(slugFromName('Team_2026 / Druck')).toBe('team-2026-druck')
    expect(slugFromName('---')).toBe('')
    expect(slugFromName('***')).toBe('')
  })

  it('keeps a derived slug within the grammar, cut at 40 without a trailing dash', () => {
    const long = slugFromName(`${'a'.repeat(39)} b c`)
    expect(long).toBe('a'.repeat(39))
    expect(TEMPLATE_SLUG.test(long)).toBe(true)
    expect(slugFromName('x'.repeat(50))).toHaveLength(40)
    for (const name of ['Ruhiges Blau', 'Größe', 'Café Noir', 'A1 b2']) expect(TEMPLATE_SLUG.test(slugFromName(name))).toBe(true)
  })

  const lib: LibraryEntry[] = [
    { slug: 'papier', name: 'Papier', origin: 'builtin', file: {} },
    { slug: 'fokus', name: 'Fokus (Instanz)', origin: 'instance', file: {} },
    { slug: 'fokus', name: 'Fokus (Space)', origin: 'space', file: {} },
  ]

  it('groups the options per scope', () => {
    const values = (o: ReturnType<typeof templateOptions>) => ({
      own: o.own.map((x) => x.value),
      instance: o.instance.map((x) => x.value),
    })
    expect(values(templateOptions('instance', lib))).toEqual({ own: ['papier', 'fokus'], instance: [] })
    expect(values(templateOptions('space', lib))).toEqual({ own: ['fokus'], instance: ['instance/papier', 'instance/fokus'] })
    expect(values(templateOptions('user', lib))).toEqual({ own: [], instance: ['instance/papier', 'instance/fokus'] })
  })

  it('lets a scope delete only its own template files', () => {
    expect(ownsTemplate('instance', { origin: 'instance' })).toBe(true)
    expect(ownsTemplate('instance', { origin: 'builtin' })).toBe(false)
    expect(ownsTemplate('space', { origin: 'space' })).toBe(true)
    expect(ownsTemplate('space', { origin: 'instance' })).toBe(false)
    expect(ownsTemplate('user', { origin: 'instance' })).toBe(false)
  })

  it('builds the library paths', () => {
    expect(libraryApiPath({ kind: 'user' })).toBe('/api/theme/library')
    expect(libraryApiPath({ kind: 'instance' }, 'fokus')).toBe('/api/theme/library/fokus')
    expect(libraryApiPath({ kind: 'space', id: 'a b' }, 'fokus')).toBe('/api/spaces/a%20b/theme/library/fokus')
  })
})

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

describe('brand helpers', () => {
  const instance = { kind: 'instance' } as const
  const space = { kind: 'space', id: 'a b' } as const
  const user = { kind: 'user' } as const

  it('allows the logo in instance and space, the favicon only in the instance, nothing for the user', () => {
    expect(brandAllowed(instance, 'logo')).toBe(true)
    expect(brandAllowed(instance, 'favicon')).toBe(true)
    expect(brandAllowed(space, 'logo')).toBe(true)
    expect(brandAllowed(space, 'favicon')).toBe(false)
    expect(brandAllowed(user, 'logo')).toBe(false)
  })

  it('builds the write paths', () => {
    expect(brandApiPath(instance, 'logo')).toBe('/api/theme/brand/logo')
    expect(brandApiPath(instance, 'favicon')).toBe('/api/theme/brand/favicon')
    expect(brandApiPath(space, 'logo')).toBe('/api/spaces/a%20b/brand/logo')
    expect(brandApiPath(space, 'favicon')).toBeNull()
    expect(brandApiPath(user, 'logo')).toBeNull()
  })

  it('derives the image URL from the saved pointer only', () => {
    const file = { brand: { logo: 'brand/logo.svg', favicon: 'brand/favicon.svg' } }
    expect(brandImageUrl(instance, file, 'logo')).toBe('/api/brand/logo')
    expect(brandImageUrl(instance, file, 'favicon')).toBe('/api/brand/favicon')
    expect(brandImageUrl(space, file, 'logo')).toBe('/api/spaces/a%20b/brand/logo')
    expect(brandImageUrl(space, file, 'favicon')).toBeNull()
    expect(brandImageUrl(instance, { brand: { name: 'X' } }, 'logo')).toBeNull()
    expect(brandImageUrl(instance, null, 'logo')).toBeNull()
    expect(brandImageUrl(user, file, 'logo')).toBeNull()
  })
})

describe('describeBrandFailure', () => {
  const invalid = (code: string) => ({ status: 'invalid', errors: [{ code, path: 'body', message: `m ${code}` }] })

  it('reads the upload codes', () => {
    expect(describeBrandFailure(422, invalid('brand_not_svg'))).toEqual({ kind: 'notSvg' })
    expect(describeBrandFailure(422, invalid('brand_too_large'))).toEqual({ kind: 'tooLarge' })
    expect(describeBrandFailure(413, null)).toEqual({ kind: 'tooLarge' })
    expect(describeBrandFailure(422, invalid('theme_file_invalid'))).toEqual({
      kind: 'invalid',
      messages: ['m theme_file_invalid'],
    })
  })

  it('reads the status codes and falls back to a plain error', () => {
    expect(describeBrandFailure(403, {})).toEqual({ kind: 'forbidden' })
    expect(describeBrandFailure(404, {})).toEqual({ kind: 'notFound' })
    expect(describeBrandFailure(409, {})).toEqual({ kind: 'conflict' })
    expect(describeBrandFailure(422, 'nonsense')).toEqual({ kind: 'error' })
    expect(describeBrandFailure(502, null)).toEqual({ kind: 'error' })
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
