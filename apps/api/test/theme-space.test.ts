import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import {
  SPACE_THEME_PATH,
  invalidateAllSpaceThemes,
  invalidateSpaceTheme,
  loadSpaceTheme,
  type SpaceThemeDeps,
} from '../src/theme/space-theme.js'
import type { SpaceConfig } from '../src/spaces/config.js'

/**
 * Theming Stage 3, unit 3.1 (space theme loader). Like `theme-instance.test.ts`
 * without a Forgejo container: a hand-built fake provider stands in.
 */

function spaceConfig(id: string): SpaceConfig {
  return {
    id,
    name: `Space ${id}`,
    provider: 'forgejo',
    owner: 'f451',
    repo: id,
    defaultLang: 'de',
    repoRef: { provider: 'forgejo', owner: 'f451', repo: id },
  }
}

const noopLogger = { warn: () => {} }

/** Fake provider: only `readFile` works, every other method throws. Counts reads per repo. */
function fakeProvider(files: Record<string, string | Error>): GitProvider & { calls: (repo: string) => number } {
  const calls = new Map<string, number>()
  const fail = (name: string) => (): never => {
    throw new Error(`GitProvider.${name}: not expected in the space theme loader`)
  }
  return {
    calls: (repo) => calls.get(repo) ?? 0,
    async readFile(repo, path, ref) {
      calls.set(repo.repo, (calls.get(repo.repo) ?? 0) + 1)
      expect(path).toBe(SPACE_THEME_PATH)
      expect(ref).toBe('main')
      const content = files[repo.repo] ?? new NotFoundError('not found')
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

function depsFor(provider: GitProvider, now?: () => number): SpaceThemeDeps {
  return { providerRegistry: () => provider, now }
}

describe('loadSpaceTheme', () => {
  afterEach(() => {
    invalidateAllSpaceThemes()
    vi.restoreAllMocks()
  })

  it('file present → space layer with the value', async () => {
    const provider = fakeProvider({ a: 'light:\n  color-accent: "#1A2B3C"\n' })
    const warn = vi.fn()
    const theme = await loadSpaceTheme(depsFor(provider), spaceConfig('a'), { warn })
    expect(theme).not.toBeNull()
    expect(theme!.layer.source).toBe('space')
    expect(theme!.layer.light).toStrictEqual({ '--color-accent': '#1a2b3c' })
    expect(theme!.errors).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('file absent (NotFoundError) → null, no warn', async () => {
    const provider = fakeProvider({})
    const warn = vi.fn()
    const debug = vi.fn()
    await expect(loadSpaceTheme(depsFor(provider), spaceConfig('a'), { warn, debug })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('two spaces are cached independently', async () => {
    const provider = fakeProvider({
      a: 'light:\n  color-accent: "#111111"\n',
      b: 'light:\n  color-accent: "#222222"\n',
    })
    const deps = depsFor(provider)
    const a1 = await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    const b1 = await loadSpaceTheme(deps, spaceConfig('b'), noopLogger)
    expect(a1!.layer.light).toStrictEqual({ '--color-accent': '#111111' })
    expect(b1!.layer.light).toStrictEqual({ '--color-accent': '#222222' })

    const a2 = await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    const b2 = await loadSpaceTheme(deps, spaceConfig('b'), noopLogger)
    expect(a2).toBe(a1)
    expect(b2).toBe(b1)
    expect(provider.calls('a')).toBe(1)
    expect(provider.calls('b')).toBe(1)
  })

  it('caches within the TTL, reads again after it', async () => {
    const provider = fakeProvider({ a: 'light:\n  color-accent: "#123456"\n' })
    let now = 1_000_000
    const deps = depsFor(provider, () => now)
    await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    expect(provider.calls('a')).toBe(1)

    now += 5 * 60 * 1000 + 1
    await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    expect(provider.calls('a')).toBe(2)
  })

  it("invalidateSpaceTheme('a') reloads only a", async () => {
    const provider = fakeProvider({
      a: 'light:\n  color-accent: "#111111"\n',
      b: 'light:\n  color-accent: "#222222"\n',
    })
    const deps = depsFor(provider)
    await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    await loadSpaceTheme(deps, spaceConfig('b'), noopLogger)

    invalidateSpaceTheme('a')
    await loadSpaceTheme(deps, spaceConfig('a'), noopLogger)
    await loadSpaceTheme(deps, spaceConfig('b'), noopLogger)
    expect(provider.calls('a')).toBe(2)
    expect(provider.calls('b')).toBe(1)
  })

  it('brand.favicon in a space file → dropped with brand_favicon_instance_only, layer still returned', async () => {
    const provider = fakeProvider({
      a: 'brand:\n  favicon: brand/favicon.svg\nlight:\n  color-accent: "#123456"\n',
    })
    const warn = vi.fn()
    const theme = await loadSpaceTheme(depsFor(provider), spaceConfig('a'), { warn })
    expect(theme).not.toBeNull()
    expect(theme!.layer.light).toStrictEqual({ '--color-accent': '#123456' })
    expect(theme!.errors.map((e) => e.code)).toEqual(['brand_favicon_instance_only'])
    expect(theme!.file.brand?.favicon).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
