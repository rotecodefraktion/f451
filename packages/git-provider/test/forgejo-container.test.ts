import { afterAll, describe, expect, it } from 'vitest'
import { startForgejo, type ForgejoTestInstance } from './helpers/forgejo-container.js'

describe.sequential('Forgejo-Testcontainer', () => {
  let inst: ForgejoTestInstance

  afterAll(async () => {
    await inst?.stop()
  })

  it('startet und beantwortet healthz', async () => {
    inst = await startForgejo()
    const res = await fetch(`${inst.baseUrl}/api/healthz`)
    expect(res.ok).toBe(true)
  }, 180_000)

  it('createRepo legt ein auto-initialisiertes Repo an (README auf main lesbar)', async () => {
    const repo = await inst.createRepo('contract-smoke')
    const res = await fetch(
      `${inst.baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}/contents/README.md?ref=main`,
      { headers: { Authorization: `token ${inst.token}` } },
    )
    expect(res.ok).toBe(true)
  }, 60_000)
})
