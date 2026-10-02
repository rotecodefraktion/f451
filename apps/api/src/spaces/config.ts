import {
  ForgejoProvider, GitHubProvider, type GitProvider, type RepoRef,
} from '@f451/git-provider'

/** Provider-Namen, die in `F451_SPACES` erlaubt sind. */
const KNOWN_PROVIDERS = ['forgejo', 'github'] as const
type Provider = (typeof KNOWN_PROVIDERS)[number]

/** Default-Sprache für Spaces ohne `defaultLang`. */
const DEFAULT_LANG = 'de'

export interface SpaceConfig {
  id: string
  name: string
  provider: Provider
  owner: string
  repo: string
  defaultLang: string
  repoRef: RepoRef
}

/** Erzwingt, dass `value` ein nicht-leerer String ist; sonst deutsche Fehlermeldung. */
function requireString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `F451_SPACES: Space an Index ${index} hat kein gültiges Pflichtfeld "${field}" (String erwartet).`,
    )
  }
  return value
}

function requireProvider(value: unknown, index: number): Provider {
  if (typeof value !== 'string' || !KNOWN_PROVIDERS.includes(value as Provider)) {
    throw new Error(
      `F451_SPACES: Space an Index ${index} hat einen unbekannten provider "${String(value)}" `
        + `(erlaubt: ${KNOWN_PROVIDERS.join(', ')}).`,
    )
  }
  return value as Provider
}

/**
 * Liest und validiert die Space-Konfiguration aus der Umgebungsvariable
 * `F451_SPACES` (JSON-Array). Wirft bei jedem Validierungsfehler sofort mit
 * einer klaren deutschen Fehlermeldung (Fail-Fast — Fehlkonfiguration ist ein
 * Deployment-Fehler, kein Laufzeitfall).
 */
export function loadSpacesConfig(env: Record<string, string | undefined>): SpaceConfig[] {
  const raw = env.F451_SPACES
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error('F451_SPACES ist nicht gesetzt. Es wird ein JSON-Array mit Space-Definitionen erwartet.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(
      `F451_SPACES enthält kein gültiges JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error('F451_SPACES muss ein JSON-Array von Space-Definitionen sein.')
  }

  const seenIds = new Set<string>()
  const spaces: SpaceConfig[] = parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`F451_SPACES: Space an Index ${index} ist kein Objekt.`)
    }
    const obj = entry as Record<string, unknown>

    const id = requireString(obj.id, 'id', index)
    const name = requireString(obj.name, 'name', index)
    const provider = requireProvider(obj.provider, index)
    const owner = requireString(obj.owner, 'owner', index)
    const repo = requireString(obj.repo, 'repo', index)

    let defaultLang = DEFAULT_LANG
    if (obj.defaultLang !== undefined) {
      defaultLang = requireString(obj.defaultLang, 'defaultLang', index)
    }

    if (seenIds.has(id)) {
      throw new Error(`F451_SPACES: Space-Id "${id}" ist doppelt vergeben. Ids müssen eindeutig sein.`)
    }
    seenIds.add(id)

    return {
      id,
      name,
      provider,
      owner,
      repo,
      defaultLang,
      repoRef: { provider, owner, repo },
    }
  })

  return spaces
}

export interface GlobalTemplatesConfig {
  provider: Provider
  owner: string
  repo: string
  repoRef: RepoRef
}

/** Erzwingt, dass `value` ein nicht-leerer String ist; sonst deutsche Fehlermeldung
 *  (Pendant zu `requireString` oben, aber für `F451_GLOBAL_TEMPLATES`). */
function requireGlobalTemplatesString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `F451_GLOBAL_TEMPLATES: kein gültiges Pflichtfeld "${field}" (String erwartet).`,
    )
  }
  return value
}

/**
 * Liest und validiert die optionale Konfiguration eines globalen
 * Templates-Repos aus der Umgebungsvariable `F451_GLOBAL_TEMPLATES` (JSON-
 * Objekt `{"provider","owner","repo"}`, Muster wie `loadSpacesConfig`).
 * `undefined`, wenn nicht gesetzt (Templates-API liefert dann nur
 * Space-Templates). Fail-Fast bei invalidem JSON/Feldern — Fehlkonfiguration
 * ist ein Deployment-Fehler, kein Laufzeitfall.
 */
export function loadGlobalTemplatesConfig(
  env: Record<string, string | undefined>,
): GlobalTemplatesConfig | undefined {
  const raw = env.F451_GLOBAL_TEMPLATES
  if (raw === undefined || raw.trim().length === 0) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(
      `F451_GLOBAL_TEMPLATES enthält kein gültiges JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('F451_GLOBAL_TEMPLATES muss ein JSON-Objekt sein.')
  }
  const obj = parsed as Record<string, unknown>

  if (typeof obj.provider !== 'string' || !KNOWN_PROVIDERS.includes(obj.provider as Provider)) {
    throw new Error(
      `F451_GLOBAL_TEMPLATES hat einen unbekannten provider "${String(obj.provider)}" `
        + `(erlaubt: ${KNOWN_PROVIDERS.join(', ')}).`,
    )
  }
  const provider = obj.provider as Provider
  const owner = requireGlobalTemplatesString(obj.owner, 'owner')
  const repo = requireGlobalTemplatesString(obj.repo, 'repo')

  return { provider, owner, repo, repoRef: { provider, owner, repo } }
}

export interface InstanceConfig {
  provider: Provider
  owner: string
  repo: string
  repoRef: RepoRef
}

/** Requires `value` to be a non-empty string (counterpart of
 *  `requireGlobalTemplatesString`, for `F451_INSTANCE_CONFIG`). */
function requireInstanceConfigString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `F451_INSTANCE_CONFIG: missing or invalid required field "${field}" (string expected).`,
    )
  }
  return value
}

/**
 * Reads and validates the optional instance repo from `F451_INSTANCE_CONFIG`
 * (JSON object `{"provider","owner","repo"}`, same shape as
 * `F451_GLOBAL_TEMPLATES`; both may name the same repo, neither requires the
 * other). The instance repo holds `_meta/theme.yaml`. `undefined` when unset —
 * then there is no instance theme. Fail-fast on invalid JSON/fields: a
 * misconfiguration is a deployment error, not a runtime case.
 */
export function loadInstanceConfig(
  env: Record<string, string | undefined>,
): InstanceConfig | undefined {
  const raw = env.F451_INSTANCE_CONFIG
  if (raw === undefined || raw.trim().length === 0) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(
      `F451_INSTANCE_CONFIG is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('F451_INSTANCE_CONFIG must be a JSON object.')
  }
  const obj = parsed as Record<string, unknown>

  if (typeof obj.provider !== 'string' || !KNOWN_PROVIDERS.includes(obj.provider as Provider)) {
    throw new Error(
      `F451_INSTANCE_CONFIG has an unknown provider "${String(obj.provider)}" `
        + `(allowed: ${KNOWN_PROVIDERS.join(', ')}).`,
    )
  }
  const provider = obj.provider as Provider
  const owner = requireInstanceConfigString(obj.owner, 'owner')
  const repo = requireInstanceConfigString(obj.repo, 'repo')

  return { provider, owner, repo, repoRef: { provider, owner, repo } }
}

/**
 * Liefert die Forgejo-Basis-URL aus derselben Umgebungsvariable wie die
 * Service-Account-Registry (`F451_FORGEJO_URL`, siehe `createProviderRegistry`
 * unten). Phase 2a Task 1 (Nutzer-Provider-Factory, `drafts/user-provider.ts`)
 * braucht diese Basis-URL, um `ForgejoProvider`-Instanzen mit dem Nutzer-Token
 * zu bauen — ohne eigene Env-Lesung, damit es nur eine Quelle für „welche
 * Forgejo-Instanz" gibt. `undefined`, wenn nicht gesetzt (z. B. reine
 * GitHub-Deployments); dann können Forgejo-Nutzer-Provider nicht gebaut werden.
 */
export function getForgejoBaseUrl(env: Record<string, string | undefined>): string | undefined {
  const baseUrl = env.F451_FORGEJO_URL
  return baseUrl && baseUrl.trim().length > 0 ? baseUrl : undefined
}

/**
 * Baut eine Provider-Registry: eine Funktion `(space) => GitProvider`, die
 * für jeden konfigurierten Space die passende Provider-Instanz liefert.
 * Instanzen werden pro Provider-Typ gecacht (ein Forgejo-Client und ein
 * GitHub-Client reichen für beliebig viele Spaces desselben Providers, da
 * beide nur mit einem Service-Account-Token arbeiten).
 *
 * Fail-Fast: prüft beim Erzeugen, dass für alle tatsächlich benutzten
 * Provider die nötigen Envs gesetzt sind, statt erst beim ersten Zugriff.
 */
export function createProviderRegistry(
  env: Record<string, string | undefined>,
): (space: SpaceConfig) => GitProvider {
  const spaces = loadSpacesConfig(env)
  const usedProviders = new Set(spaces.map((s) => s.provider))

  const instances = new Map<Provider, GitProvider>()

  function buildForgejo(): GitProvider {
    const baseUrl = env.F451_FORGEJO_URL
    const token = env.F451_FORGEJO_TOKEN
    if (!baseUrl || baseUrl.trim().length === 0) {
      throw new Error(
        'F451_FORGEJO_URL ist nicht gesetzt, wird aber für mindestens einen konfigurierten Forgejo-Space benötigt.',
      )
    }
    if (!token || token.trim().length === 0) {
      throw new Error(
        'F451_FORGEJO_TOKEN ist nicht gesetzt, wird aber für mindestens einen konfigurierten Forgejo-Space benötigt.',
      )
    }
    return new ForgejoProvider({ baseUrl, token })
  }

  function buildGitHub(): GitProvider {
    const token = env.F451_GITHUB_TOKEN
    if (!token || token.trim().length === 0) {
      throw new Error(
        'F451_GITHUB_TOKEN ist nicht gesetzt, wird aber für mindestens einen konfigurierten GitHub-Space benötigt.',
      )
    }
    return new GitHubProvider({ token })
  }

  // Fail-Fast: sofort beim Erzeugen der Registry prüfen, nicht erst beim ersten Zugriff.
  if (usedProviders.has('forgejo')) instances.set('forgejo', buildForgejo())
  if (usedProviders.has('github')) instances.set('github', buildGitHub())

  return (space: SpaceConfig): GitProvider => {
    const instance = instances.get(space.provider)
    if (!instance) {
      // Kann durch die Fail-Fast-Prüfung oben nicht eintreten, sofern `space`
      // aus derselben Konfiguration stammt wie die Registry.
      throw new Error(`Kein Provider für Space "${space.id}" (provider: ${space.provider}) registriert.`)
    }
    return instance
  }
}
