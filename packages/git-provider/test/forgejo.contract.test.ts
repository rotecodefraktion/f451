import { afterAll } from 'vitest'
import { runGitProviderContractTests } from './contract-suite.js'
import { startForgejo, type ForgejoTestInstance } from './helpers/forgejo-container.js'
import { ForgejoProvider } from '../src/forgejo.js'

let inst: ForgejoTestInstance | undefined

afterAll(async () => {
  await inst?.stop()
})

runGitProviderContractTests(
  'Forgejo',
  async () => {
    inst = await startForgejo()
    const repo = await inst.createRepo('contract')
    // Zweiter Testnutzer für den "Review-Workflow"-Block: braucht mind.
    // Schreibzugriff, um den PR überhaupt zu sehen und zu reviewen.
    const reviewerUser = await inst.createUser('reviewer')
    await inst.addCollaborator(repo, reviewerUser.username, 'write')
    return {
      provider: new ForgejoProvider({ baseUrl: inst.baseUrl, token: inst.token }),
      repo,
      reviewer: {
        provider: new ForgejoProvider({ baseUrl: inst.baseUrl, token: reviewerUser.token }),
        username: reviewerUser.username,
      },
    }
  },
  { supportsReviewWorkflow: true },
)
