import { describe, expect, it } from 'vitest'
import type { PullRequestInfo, RepoRef } from '../src/types.js'
import { waitForMergeableResolved } from './contract-suite.js'

const REPO: RepoRef = { owner: 'o', name: 'r' }

/** Stub, der `mergeable` in der vorgegebenen Sequenz liefert (letzter Wert hält). */
function providerWithMergeableSequence(sequence: Array<boolean | null>) {
  let calls = 0
  return {
    calls: () => calls,
    getPullRequest: async (): Promise<PullRequestInfo> => {
      const mergeable = sequence[Math.min(calls, sequence.length - 1)]
      calls += 1
      return { number: 1, title: 't', state: 'open', mergeable } as PullRequestInfo
    },
  }
}

describe('waitForMergeableResolved (Poll-Logik der Contract-Suite)', () => {
  it('false ist KEIN Endzustand: pollt weiter, bis der asynchrone Check true liefert', async () => {
    // Forgejo/Gitea melden mergeable=false, WÄHREND der Konflikt-Check noch läuft
    // (gitea models/issues/pull.go: Mergeable() false bei Status „Checking") —
    // genau diese Transition false→false→true färbte die Suite unter Docker-Last rot.
    const stub = providerWithMergeableSequence([false, false, true])
    await expect(waitForMergeableResolved(stub, REPO, 1, 5_000)).resolves.toBe(true)
    expect(stub.calls()).toBe(3)
  })

  it('null (GitHub „wird berechnet") wird ebenfalls weitergepollt', async () => {
    const stub = providerWithMergeableSequence([null, true])
    await expect(waitForMergeableResolved(stub, REPO, 1, 5_000)).resolves.toBe(true)
  })

  it('echter Konflikt: liefert nach ausgeschöpftem Budget den zuletzt gesehenen Wert false', async () => {
    const stub = providerWithMergeableSequence([false])
    await expect(waitForMergeableResolved(stub, REPO, 1, 300)).resolves.toBe(false)
  })
})
