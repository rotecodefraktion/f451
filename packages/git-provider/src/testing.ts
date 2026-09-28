import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import type { RepoRef } from './types.js'

export interface ForgejoTestUser {
  username: string
  token: string
}

export interface ForgejoTestInstance {
  baseUrl: string
  token: string
  /**
   * Legt ein frisches, auto-initialisiertes Repo (main + README.md) unter dem
   * Admin-User an. Mit `private: true` als privates Repo — für Berechtigungs-
   * Tests, in denen ein fremder Nutzer es NICHT lesen können soll.
   */
  createRepo(name: string, opts?: { private?: boolean }): Promise<RepoRef>
  /**
   * Legt einen weiteren Nutzer (Nicht-Admin) samt API-Token per CLI an — für
   * Berechtigungs-Vererbungs-Tests, die pro Nutzer unterschiedliche Repo-
   * Sichtbarkeit prüfen (Phase 1d Task 5).
   */
  createUser(username: string): Promise<ForgejoTestUser>
  /**
   * Fügt einen Nutzer als Collaborator mit der gegebenen Berechtigungsstufe zu
   * einem Repo hinzu (Forgejo-API `PUT /repos/{owner}/{repo}/collaborators/{user}`,
   * Body `{permission}`) — für Schreibrechte-Vererbungs-Tests (Phase 2a Task 1),
   * in denen ein Nutzer explizit nur Lese- oder auch Schreibzugriff auf ein
   * fremdes Repo bekommt.
   */
  addCollaborator(repo: RepoRef, username: string, permission: 'read' | 'write' | 'admin'): Promise<void>
  stop(): Promise<void>
}

const ADMIN = 'contract-admin'
const PASS = 'contract-pass-1234'

/** Startet Forgejo 11 als Testcontainer, legt Admin + API-Token per CLI an. */
export async function startForgejo(): Promise<ForgejoTestInstance> {
  const container: StartedTestContainer = await new GenericContainer('codeberg.org/forgejo/forgejo:11')
    .withEnvironment({
      FORGEJO__security__INSTALL_LOCK: 'true',
      FORGEJO__database__DB_TYPE: 'sqlite3',
      FORGEJO__server__ROOT_URL: 'http://localhost:3000/',
    })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/api/healthz', 3000).withStartupTimeout(120_000))
    .start()

  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(3000)}`

  const create = await container.exec([
    'su', 'git', '-c',
    `forgejo admin user create --admin --username ${ADMIN} --password ${PASS} --email ${ADMIN}@test.local`,
  ])
  if (create.exitCode !== 0 && !create.output.includes('already exists')) {
    throw new Error(`Admin-Anlage fehlgeschlagen: ${create.output}`)
  }

  const tok = await container.exec([
    'su', 'git', '-c',
    `forgejo admin user generate-access-token --username ${ADMIN} --token-name contract --scopes all --raw`,
  ])
  if (tok.exitCode !== 0) throw new Error(`Token-Erzeugung fehlgeschlagen: ${tok.output}`)
  const token = tok.output.trim().split('\n').at(-1)!.trim()

  let repoCounter = 0
  let userCounter = 0
  return {
    baseUrl,
    token,
    async createRepo(name: string, opts: { private?: boolean } = {}): Promise<RepoRef> {
      const unique = `${name}-${++repoCounter}`
      const res = await fetch(`${baseUrl}/api/v1/user/repos`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: unique,
          auto_init: true,
          default_branch: 'main',
          private: opts.private ?? false,
        }),
      })
      if (!res.ok) throw new Error(`Repo-Anlage fehlgeschlagen (${res.status}): ${await res.text()}`)
      return { provider: 'forgejo', owner: ADMIN, repo: unique }
    },
    async createUser(username: string): Promise<ForgejoTestUser> {
      const unique = `${username}-${++userCounter}`
      const pass = 'reader-pass-1234'
      const create = await container.exec([
        'su', 'git', '-c',
        `forgejo admin user create --username ${unique} --password ${pass} `
          + `--email ${unique}@test.local --must-change-password=false`,
      ])
      if (create.exitCode !== 0 && !create.output.includes('already exists')) {
        throw new Error(`Nutzer-Anlage fehlgeschlagen: ${create.output}`)
      }
      const tok = await container.exec([
        'su', 'git', '-c',
        `forgejo admin user generate-access-token --username ${unique} `
          + `--token-name t --scopes all --raw`,
      ])
      if (tok.exitCode !== 0) throw new Error(`Token-Erzeugung fehlgeschlagen: ${tok.output}`)
      const userToken = tok.output.trim().split('\n').at(-1)!.trim()
      return { username: unique, token: userToken }
    },
    async addCollaborator(repo: RepoRef, username: string, permission: 'read' | 'write' | 'admin'): Promise<void> {
      const res = await fetch(
        `${baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}/collaborators/${username}`,
        {
          method: 'PUT',
          headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ permission }),
        },
      )
      if (!res.ok) throw new Error(`Collaborator-Anlage fehlgeschlagen (${res.status}): ${await res.text()}`)
    },
    async stop() {
      await container.stop()
    },
  }
}
