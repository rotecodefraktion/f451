import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ForgejoProvider, GitHubProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { createDb, type Db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { getForgejoBaseUrl, type SpaceConfig } from '../src/spaces/config.js'
import { getUserProvider, type UserProviderDeps } from '../src/drafts/user-provider.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

/**
 * Nutzer-Provider-Factory (Phase 2a Task 1): `getUserProvider` liefert eine
 * `GitProvider`-Instanz, die tatsächlich mit dem Token des jeweiligen Nutzers
 * arbeitet — geprüft, indem eine funktionsfähige Instanz gegen den echten
 * Forgejo-Container ein Repo liest (`readFile`). Kein verknüpftes Konto → null
 * (Aufrufer mappt das später auf 403 mit „Konto verknüpfen"-Hinweis).
 */
describe.sequential('getUserProvider (Phase 2a Task 1)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let deps: UserProviderDeps

  let space: SpaceConfig
  const linkedUserId = 'up-linked'
  const noAccountUserId = 'up-no-account'

  const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    const adminProvider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    const repo: RepoRef = await forgejo.createRepo('user-provider-repo')
    await adminProvider.writeFile(
      repo,
      'index.md',
      '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nInhalt.\n',
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'up-space', name: 'UP Space', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }

    await db.insert(users).values([
      { id: linkedUserId, email: 'linked@example.org', displayName: 'Linked' },
      { id: noAccountUserId, email: 'noacc@example.org', displayName: 'No Account' },
    ])
    // Verknüpft mit dem Admin-Token — reicht, um eine funktionsfähige Instanz
    // gegen das Testrepo nachzuweisen (readFile).
    await upsertProviderAccount(
      db, linkedUserId, 'forgejo', 'contract-admin', { accessToken: forgejo.token }, TOKEN_KEY,
    )

    deps = { db, tokenKey: TOKEN_KEY, forgejoBaseUrl: getForgejoBaseUrl({ F451_FORGEJO_URL: forgejo.baseUrl }) }
  }, 240_000)

  afterAll(async () => {
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('liefert eine funktionsfähige ForgejoProvider-Instanz (readFile klappt) für einen verknüpften Nutzer', async () => {
    const provider = await getUserProvider(deps, linkedUserId, space)
    expect(provider).not.toBeNull()
    expect(provider).toBeInstanceOf(ForgejoProvider)

    const file = await provider!.readFile(space.repoRef, 'index.md', 'main')
    expect(file.content).toContain('# Home')
  })

  it('liefert null ohne verknüpftes Konto', async () => {
    const provider = await getUserProvider(deps, noAccountUserId, space)
    expect(provider).toBeNull()
  })

  it('liefert null für Forgejo-Spaces, wenn keine forgejoBaseUrl konfiguriert ist', async () => {
    const depsWithoutBaseUrl: UserProviderDeps = { db, tokenKey: TOKEN_KEY }
    const provider = await getUserProvider(depsWithoutBaseUrl, linkedUserId, space)
    expect(provider).toBeNull()
  })

  it('liefert eine GitHubProvider-Instanz für GitHub-Spaces (kein Forgejo-Basis-URL-Bedarf)', async () => {
    await upsertProviderAccount(
      db, linkedUserId, 'github', 'octocat', { accessToken: 'gh-fake-token' }, TOKEN_KEY,
    )
    const githubSpace: SpaceConfig = {
      id: 'up-gh-space', name: 'UP GitHub Space', provider: 'github',
      owner: 'octo-org', repo: 'octo-repo', defaultLang: 'de',
      repoRef: { provider: 'github', owner: 'octo-org', repo: 'octo-repo' },
    }
    const depsWithoutBaseUrl: UserProviderDeps = { db, tokenKey: TOKEN_KEY }
    const provider = await getUserProvider(depsWithoutBaseUrl, linkedUserId, githubSpace)
    expect(provider).toBeInstanceOf(GitHubProvider)
  })
})
