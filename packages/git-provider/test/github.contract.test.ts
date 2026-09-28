import { describe } from 'vitest'
import { runGitProviderContractTests } from './contract-suite.js'
import { GitHubProvider } from '../src/github.js'

// Hinweis: Das Live-Repo muss frisch/auto-initialisiert sein (main + README) und gehört
// nach dem Lauf gelöscht — der Lauf ist destruktiv-additiv.

const enabled = process.env.GITHUB_CONTRACT === '1'
const token = process.env.GITHUB_CONTRACT_TOKEN
const target = process.env.GITHUB_CONTRACT_REPO // Format: owner/repo — frisches Test-Repo!

describe.skipIf(!enabled)('GitHub Live-Contract (env-gated)', () => {
  if (!enabled) return
  if (!token || !target) throw new Error('GITHUB_CONTRACT_TOKEN und GITHUB_CONTRACT_REPO setzen')
  const [owner, repo] = target.split('/') as [string, string]
  runGitProviderContractTests('GitHub (live)', async () => ({
    provider: new GitHubProvider({ token }),
    repo: { provider: 'github', owner, repo },
  }))
})
