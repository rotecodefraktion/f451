import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import {
  INSTANCE_THEME_PATH,
  invalidateInstanceTheme,
  loadInstanceTheme,
  type InstanceThemeDeps,
} from '../src/theme/instance-theme.js'
import type { InstanceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 2, unit 2.1 (instance theme loader). Like `metadata-schema.test.ts`
 * without a Forgejo container: the loader depends only on the `GitProvider`
 * contract, so a hand-built fake provider stands in.
 */

const instanceConfig: InstanceConfig = {
  provider: 'forgejo',
  owner: 'f451',
  repo: 'instance',
  repoRef: { provider: 'forgejo', owner: 'f451', repo: 'instance' },
}

const noopLogger = { warn: () => {} }

/** Fake provider: only `readFile` works, every other method throws. Counts reads. */
function providerWithThemeFile(content: string | Error): GitProvider & { calls: () => number } {
  let calls = 0
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the instance theme loader`)
  }
  return {
    calls: () => calls,
    async readFile(repo, path, ref) {
      calls += 1
      expect(repo).toEqual(instanceConfig.repoRef)
      expect(path).toBe(INSTANCE_THEME_PATH)
      expect(ref).toBe('main')
      if (content instanceof Error) throw content
      return { path, content, sha: 'abc' }
    },
    readFileBinary: fail('readFileBinary'),
    listTree: fail('listTree'),
    getHeadSha: fail('getHeadSha'),
    writeFile: fail('writeFile'),
    writeFileBinary: fail('writeFileBinary'),
    createBranch: fail('createBranch'),
    deleteBranch: fail('deleteBranch'),
    listCommits: fail('listCommits'),
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

describe('loadInstanceTheme', () => {
  afterEach(() => {
    invalidateInstanceTheme()
    vi.restoreAllMocks()
  })

  it('file present → instance layer with the value', async () => {
    const provider = providerWithThemeFile('name: House\nlight:\n  color-accent: "#1A2B3C"\n')
    const warn = vi.fn()
    const theme = await loadInstanceTheme(depsFor(provider), { warn })
    expect(theme).not.toBeNull()
    expect(theme!.layer.source).toBe('instance')
    expect(theme!.layer.light).toStrictEqual({ '--color-accent': '#1a2b3c' })
    expect(theme!.errors).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('file absent (NotFoundError) → null, debug log only (a repo without a theme is normal), no throw', async () => {
    const provider = providerWithThemeFile(new NotFoundError('not found'))
    const warn = vi.fn()
    const debug = vi.fn()
    await expect(loadInstanceTheme(depsFor(provider), { warn, debug })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('provider error → null with a warn log, no throw', async () => {
    const provider = providerWithThemeFile(new Error('simulated provider outage'))
    const warn = vi.fn()
    await expect(loadInstanceTheme(depsFor(provider), { warn })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('broken YAML → null with a warn log, no throw', async () => {
    const provider = providerWithThemeFile('light: [broken')
    const warn = vi.fn()
    await expect(loadInstanceTheme(depsFor(provider), { warn })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('unknown token → dropped with a warning, the rest is still a layer', async () => {
    const provider = providerWithThemeFile('light:\n  color-accent: "#123456"\n  color-nope: "#000000"\n')
    const warn = vi.fn()
    const theme = await loadInstanceTheme(depsFor(provider), { warn })
    expect(theme).not.toBeNull()
    expect(theme!.layer.light).toStrictEqual({ '--color-accent': '#123456' })
    expect(theme!.errors.map((e) => e.code)).toEqual(['token_unknown'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('caches within the TTL — the second call does not hit the provider', async () => {
    const provider = providerWithThemeFile('light:\n  color-accent: "#123456"\n')
    let now = 1_000_000
    const deps = depsFor(provider, () => now)
    const first = await loadInstanceTheme(deps, noopLogger)
    const second = await loadInstanceTheme(deps, noopLogger)
    expect(provider.calls()).toBe(1)
    expect(second).toBe(first)

    // After the TTL (5 min) the file is read again.
    now += 5 * 60 * 1000 + 1
    await loadInstanceTheme(deps, noopLogger)
    expect(provider.calls()).toBe(2)
  })

  it('invalidateInstanceTheme forces a reload', async () => {
    const provider = providerWithThemeFile('light:\n  color-accent: "#123456"\n')
    const deps = depsFor(provider)
    await loadInstanceTheme(deps, noopLogger)
    invalidateInstanceTheme()
    await loadInstanceTheme(deps, noopLogger)
    expect(provider.calls()).toBe(2)
  })

  it('no instanceConfig → null without touching the provider', async () => {
    const registry = vi.fn(() => providerWithThemeFile('light: {}'))
    const warn = vi.fn()
    const theme = await loadInstanceTheme({ providerRegistry: registry }, { warn })
    expect(theme).toBeNull()
    expect(registry).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
