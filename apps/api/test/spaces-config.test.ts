import { describe, expect, it } from 'vitest'
import { ForgejoProvider, GitHubProvider } from '@f451/git-provider'
import { createProviderRegistry, loadGlobalTemplatesConfig, loadSpacesConfig } from '../src/spaces/config.js'

const validSpacesJson = JSON.stringify([
  {
    id: 'betrieb',
    name: 'Betrieb',
    provider: 'forgejo',
    owner: 'dev-docs',
    repo: 'betrieb',
    defaultLang: 'de',
  },
  {
    id: 'oss',
    name: 'Open Source',
    provider: 'github',
    owner: 'f451',
    repo: 'oss-docs',
  },
])

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    F451_SPACES: validSpacesJson,
    F451_FORGEJO_URL: 'https://git.example.com',
    F451_FORGEJO_TOKEN: 'forgejo-token',
    F451_GITHUB_TOKEN: 'github-token',
    ...overrides,
  }
}

describe('loadSpacesConfig', () => {
  it('lädt eine gültige Konfiguration', () => {
    const spaces = loadSpacesConfig(baseEnv())
    expect(spaces).toHaveLength(2)
    expect(spaces[0]).toEqual({
      id: 'betrieb',
      name: 'Betrieb',
      provider: 'forgejo',
      owner: 'dev-docs',
      repo: 'betrieb',
      defaultLang: 'de',
      repoRef: { provider: 'forgejo', owner: 'dev-docs', repo: 'betrieb' },
    })
  })

  it('setzt defaultLang standardmäßig auf "de", wenn nicht angegeben', () => {
    const spaces = loadSpacesConfig(baseEnv())
    const oss = spaces.find((s) => s.id === 'oss')
    expect(oss?.defaultLang).toBe('de')
  })

  it('wirft, wenn F451_SPACES fehlt', () => {
    expect(() => loadSpacesConfig({})).toThrow(/F451_SPACES/)
  })

  it('wirft bei ungültigem JSON', () => {
    expect(() => loadSpacesConfig(baseEnv({ F451_SPACES: '{not valid json' }))).toThrow(
      /F451_SPACES.*JSON|JSON.*F451_SPACES/i,
    )
  })

  it('wirft, wenn F451_SPACES kein Array ist', () => {
    expect(() => loadSpacesConfig(baseEnv({ F451_SPACES: '{"id":"x"}' }))).toThrow(/Array/)
  })

  it('wirft bei fehlendem Pflichtfeld (id)', () => {
    const json = JSON.stringify([{ name: 'Betrieb', provider: 'forgejo', owner: 'dev-docs', repo: 'betrieb' }])
    expect(() => loadSpacesConfig(baseEnv({ F451_SPACES: json }))).toThrow(/id/)
  })

  it('wirft bei fehlendem Pflichtfeld (owner)', () => {
    const json = JSON.stringify([{ id: 'betrieb', name: 'Betrieb', provider: 'forgejo', repo: 'betrieb' }])
    expect(() => loadSpacesConfig(baseEnv({ F451_SPACES: json }))).toThrow(/owner/)
  })

  it('wirft bei unbekanntem Provider', () => {
    const json = JSON.stringify([
      { id: 'betrieb', name: 'Betrieb', provider: 'gitlab', owner: 'dev-docs', repo: 'betrieb' },
    ])
    expect(() => loadSpacesConfig(baseEnv({ F451_SPACES: json }))).toThrow(/provider/i)
  })

  it('wirft bei doppelten Space-Ids', () => {
    const json = JSON.stringify([
      { id: 'betrieb', name: 'Betrieb', provider: 'forgejo', owner: 'dev-docs', repo: 'betrieb' },
      { id: 'betrieb', name: 'Betrieb 2', provider: 'forgejo', owner: 'dev-docs', repo: 'betrieb2' },
    ])
    expect(() => loadSpacesConfig(baseEnv({ F451_SPACES: json }))).toThrow(/betrieb.*doppelt|doppelt.*betrieb/i)
  })
})

describe('createProviderRegistry', () => {
  it('wirft beim Erzeugen, wenn Forgejo-Token für benutzten Space fehlt', () => {
    expect(() =>
      createProviderRegistry(baseEnv({ F451_FORGEJO_TOKEN: undefined })),
    ).toThrow(/F451_FORGEJO_TOKEN/)
  })

  it('wirft beim Erzeugen, wenn Forgejo-URL für benutzten Space fehlt', () => {
    expect(() =>
      createProviderRegistry(baseEnv({ F451_FORGEJO_URL: undefined })),
    ).toThrow(/F451_FORGEJO_URL/)
  })

  it('wirft beim Erzeugen, wenn GitHub-Token für benutzten Space fehlt', () => {
    expect(() =>
      createProviderRegistry(baseEnv({ F451_GITHUB_TOKEN: undefined })),
    ).toThrow(/F451_GITHUB_TOKEN/)
  })

  it('liefert für einen Forgejo-Space eine ForgejoProvider-Instanz', () => {
    const registry = createProviderRegistry(baseEnv())
    const spaces = loadSpacesConfig(baseEnv())
    const betrieb = spaces.find((s) => s.id === 'betrieb')!
    const provider = registry(betrieb)
    expect(provider).toBeInstanceOf(ForgejoProvider)
  })

  it('liefert für einen GitHub-Space eine GitHubProvider-Instanz', () => {
    const registry = createProviderRegistry(baseEnv())
    const spaces = loadSpacesConfig(baseEnv())
    const oss = spaces.find((s) => s.id === 'oss')!
    const provider = registry(oss)
    expect(provider).toBeInstanceOf(GitHubProvider)
  })

  it('cached Provider-Instanzen pro Provider-Typ', () => {
    const registry = createProviderRegistry(baseEnv())
    const spaces = loadSpacesConfig(baseEnv())
    const betrieb = spaces.find((s) => s.id === 'betrieb')!

    const first = registry(betrieb)
    const second = registry(betrieb)
    expect(first).toBe(second)
  })

  it('cached Provider-Instanzen auch über mehrere Spaces desselben Providers hinweg', () => {
    const json = JSON.stringify([
      { id: 'a', name: 'A', provider: 'forgejo', owner: 'dev-docs', repo: 'a' },
      { id: 'b', name: 'B', provider: 'forgejo', owner: 'dev-docs', repo: 'b' },
    ])
    const env = baseEnv({ F451_SPACES: json })
    const registry = createProviderRegistry(env)
    const spaces = loadSpacesConfig(env)

    const providerA = registry(spaces.find((s) => s.id === 'a')!)
    const providerB = registry(spaces.find((s) => s.id === 'b')!)
    expect(providerA).toBe(providerB)
  })

  it('liefert nicht dieselbe Instanz für unterschiedliche Provider-Typen', () => {
    const registry = createProviderRegistry(baseEnv())
    const spaces = loadSpacesConfig(baseEnv())
    const betrieb = spaces.find((s) => s.id === 'betrieb')!
    const oss = spaces.find((s) => s.id === 'oss')!

    expect(registry(betrieb)).not.toBe(registry(oss))
  })
})

describe('loadGlobalTemplatesConfig', () => {
  it('liefert undefined, wenn F451_GLOBAL_TEMPLATES nicht gesetzt ist', () => {
    expect(loadGlobalTemplatesConfig({})).toBeUndefined()
  })

  it('liefert undefined bei leerem String', () => {
    expect(loadGlobalTemplatesConfig({ F451_GLOBAL_TEMPLATES: '   ' })).toBeUndefined()
  })

  it('lädt eine gültige Konfiguration', () => {
    const cfg = loadGlobalTemplatesConfig({
      F451_GLOBAL_TEMPLATES: JSON.stringify({ provider: 'forgejo', owner: 'f451', repo: 'templates' }),
    })
    expect(cfg).toEqual({
      provider: 'forgejo',
      owner: 'f451',
      repo: 'templates',
      repoRef: { provider: 'forgejo', owner: 'f451', repo: 'templates' },
    })
  })

  it('wirft bei ungültigem JSON', () => {
    expect(() =>
      loadGlobalTemplatesConfig({ F451_GLOBAL_TEMPLATES: '{not valid json' }),
    ).toThrow(/F451_GLOBAL_TEMPLATES.*JSON|JSON.*F451_GLOBAL_TEMPLATES/i)
  })

  it('wirft, wenn kein JSON-Objekt (Array)', () => {
    expect(() =>
      loadGlobalTemplatesConfig({ F451_GLOBAL_TEMPLATES: '[]' }),
    ).toThrow(/Objekt/)
  })

  it('wirft bei unbekanntem Provider', () => {
    expect(() =>
      loadGlobalTemplatesConfig({
        F451_GLOBAL_TEMPLATES: JSON.stringify({ provider: 'gitlab', owner: 'f451', repo: 'templates' }),
      }),
    ).toThrow(/provider/i)
  })

  it('wirft bei fehlendem Pflichtfeld (owner)', () => {
    expect(() =>
      loadGlobalTemplatesConfig({
        F451_GLOBAL_TEMPLATES: JSON.stringify({ provider: 'forgejo', repo: 'templates' }),
      }),
    ).toThrow(/owner/)
  })

  it('wirft bei fehlendem Pflichtfeld (repo)', () => {
    expect(() =>
      loadGlobalTemplatesConfig({
        F451_GLOBAL_TEMPLATES: JSON.stringify({ provider: 'forgejo', owner: 'f451' }),
      }),
    ).toThrow(/repo/)
  })
})
