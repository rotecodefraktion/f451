import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THRESHOLDS } from '@f451/design-tokens'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import {
  checkThresholds,
  CONTRAST_CONFIG_PATH,
  invalidateContrastThresholds,
  loadContrastConfig,
  loadContrastThresholds,
  serializeContrastFile,
} from '../src/theme/contrast-config.js'
import type { InstanceThemeDeps } from '../src/theme/instance-theme.js'
import type { InstanceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 4, unit 4.2 (contrast thresholds loader). Fake provider as in
 * `theme-instance.test.ts`: only `readFile` of `_meta/contrast.yaml` works.
 */

const instanceConfig: InstanceConfig = {
  provider: 'forgejo',
  owner: 'f451',
  repo: 'instance',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'instance' },
}

const noopLogger = { warn: () => {} }

function providerWithFile(content: string | Error): GitProvider & { calls: () => number } {
  let calls = 0
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the contrast loader`)
  }
  return {
    calls: () => calls,
    async readFile(repo, path, ref) {
      calls += 1
      expect(repo).toEqual(instanceConfig.repoRef)
      expect(path).toBe(CONTRAST_CONFIG_PATH)
      expect(ref).toBe('main')
      if (content instanceof Error) throw content
      return { path, content, sha: 'abc' }
    },
    readFileBinary: fail('readFileBinary'),
    listTree: fail('listTree'),
    getHeadSha: fail('getHeadSha'),
    writeFile: fail('writeFile'),
    writeFileBinary: fail('writeFileBinary'),
    deleteFile: fail('deleteFile'),
    commitFiles: fail('commitFiles'),
    createBranch: fail('createBranch'),
    deleteBranch: fail('deleteBranch'),
    listCommits: fail('listCommits'),
    countCommitsAhead: fail('countCommitsAhead'),
    createPullRequest: fail('createPullRequest'),
    getPullRequest: fail('getPullRequest'),
    listPullRequests: fail('listPullRequests'),
    requestReviewers: fail('requestReviewers'),
    submitPullRequestReview: fail('submitPullRequestReview'),
    mergePullRequest: fail('mergePullRequest'),
  }
}

function depsFor(provider: GitProvider, now?: () => number): InstanceThemeDeps {
  return { providerRegistry: () => provider, instanceConfig, now }
}

const FULL_FILE = [
  'thresholds:',
  '  body-text: 5.0',
  '  ui-text: 4.0',
  '  incidental: 2.5',
  '  non-text: 3.5',
  'note: Tints are remixed in Q4.',
  '',
].join('\n')

describe('loadContrastThresholds', () => {
  afterEach(() => {
    invalidateContrastThresholds()
    vi.restoreAllMocks()
  })

  it('file present → its values under the spec key names, source instance, note kept', async () => {
    const warn = vi.fn()
    const config = await loadContrastConfig(depsFor(providerWithFile(FULL_FILE)), { warn })
    expect(config.thresholds).toEqual({ readingText: 5, shortText: 4, nonText: 3.5, incidental: 2.5 })
    expect(config.source).toBe('instance')
    expect(config.note).toBe('Tints are remixed in Q4.')
    expect(config.problems).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a key the file leaves out falls back to its default', async () => {
    const thresholds = await loadContrastThresholds(
      depsFor(providerWithFile('thresholds:\n  incidental: 1.5\n')),
      noopLogger,
    )
    expect(thresholds).toEqual({ ...DEFAULT_THRESHOLDS, incidental: 1.5 })
  })

  it('file absent → defaults, no log', async () => {
    const warn = vi.fn()
    const debug = vi.fn()
    const config = await loadContrastConfig(depsFor(providerWithFile(new NotFoundError('nope'))), { warn, debug })
    expect(config.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(config.source).toBe('default')
    expect(config.problems).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('one value out of range → the whole file is ignored (spec), defaults with a warning', async () => {
    const warn = vi.fn()
    const file = 'thresholds:\n  body-text: 5.0\n  ui-text: 1.0\n'
    const config = await loadContrastConfig(depsFor(providerWithFile(file)), { warn })
    expect(config.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(config.source).toBe('default')
    expect(config.problems.map((p) => [p.code, p.key])).toEqual([['threshold_out_of_range', 'shortText']])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a non-numeric value → defaults with a warning', async () => {
    const warn = vi.fn()
    const config = await loadContrastConfig(depsFor(providerWithFile('thresholds:\n  non-text: "3.0"\n')), { warn })
    expect(config.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(config.problems.map((p) => p.code)).toEqual(['threshold_not_a_number'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('an unknown threshold key is ignored with a warning, the rest applies', async () => {
    const warn = vi.fn()
    const config = await loadContrastConfig(
      depsFor(providerWithFile('thresholds:\n  ui-text: 3.0\n  focus: 2.0\n')),
      { warn },
    )
    expect(config.thresholds.shortText).toBe(3)
    expect(config.source).toBe('instance')
    expect(config.problems.map((p) => p.code)).toEqual(['key_unknown'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('broken YAML → defaults with a warning, no throw', async () => {
    const warn = vi.fn()
    const config = await loadContrastConfig(depsFor(providerWithFile('thresholds: [broken')), { warn })
    expect(config.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('caches within the TTL and reads again after it', async () => {
    const provider = providerWithFile(FULL_FILE)
    let now = 1_000_000
    const deps = depsFor(provider, () => now)
    await loadContrastThresholds(deps, noopLogger)
    await loadContrastThresholds(deps, noopLogger)
    expect(provider.calls()).toBe(1)
    now += 5 * 60 * 1000 + 1
    await loadContrastThresholds(deps, noopLogger)
    expect(provider.calls()).toBe(2)
  })

  it('invalidateContrastThresholds forces a reload', async () => {
    const provider = providerWithFile(FULL_FILE)
    const deps = depsFor(provider)
    await loadContrastThresholds(deps, noopLogger)
    invalidateContrastThresholds()
    await loadContrastThresholds(deps, noopLogger)
    expect(provider.calls()).toBe(2)
  })

  it('no instanceConfig → defaults without touching the provider', async () => {
    const registry = vi.fn(() => providerWithFile(FULL_FILE))
    const thresholds = await loadContrastThresholds({ providerRegistry: registry }, noopLogger)
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(registry).not.toHaveBeenCalled()
  })

  it('the returned defaults are a copy — mutating them does not alter DEFAULT_THRESHOLDS', async () => {
    const thresholds = await loadContrastThresholds({}, noopLogger)
    thresholds.readingText = 7
    expect(DEFAULT_THRESHOLDS.readingText).toBe(4.5)
  })
})

describe('checkThresholds', () => {
  it('accepts the bounds 1.5 and 7.0', () => {
    expect(checkThresholds({ readingText: 7, nonText: 1.5 }).ok).toBe(true)
  })

  it('rejects more than one decimal place', () => {
    const result = checkThresholds({ shortText: 3.47 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problem).toMatchObject({ code: 'threshold_precision', key: 'shortText' })
  })

  it('rejects a reversed order of the text roles, measured against the defaults', () => {
    const result = checkThresholds({ incidental: 4.0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problem).toMatchObject({ code: 'threshold_order', key: 'incidental' })
  })

  it('nonText is outside the order', () => {
    expect(checkThresholds({ nonText: 7 }).ok).toBe(true)
  })
})

describe('serializeContrastFile', () => {
  it('writes only the set keys under the spec names, plus the note', () => {
    const text = serializeContrastFile({ shortText: 3, incidental: 2.5 }, 'why')
    expect(text).toContain('ui-text: 3')
    expect(text).toContain('incidental: 2.5')
    expect(text).not.toContain('body-text')
    expect(text).toContain('note: why')
  })
})
