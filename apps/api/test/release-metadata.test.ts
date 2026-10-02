import { describe, expect, it } from 'vitest'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { parsePage, type MetadataSchema } from '@f451/markdown'
import { applyVersionOnDraft, fillReleaseMetadataOnDraft } from '../src/drafts/release-metadata.js'

/**
 * Metadaten-Feature M3b Teil B: `fillReleaseMetadataOnDraft` orchestriert nur
 * `readFile`/`writeFile` auf einem GitProvider — reiner Fake statt Forgejo-
 * Container genügt und hält den Test schnell (Muster
 * `pages-metadata-auto.test.ts`). Der End-zu-Ende-Fall (echter Merge inkl.
 * Vorbelegung) ist `workflow-routes.test.ts` (echter Forgejo-Container).
 */
describe('fillReleaseMetadataOnDraft', () => {
  const repo: RepoRef = { provider: 'forgejo', owner: 'o', repo: 'r' }
  const path = 'seite/index.md'
  const branch = 'draft/seite'
  const values = { actor: 'Releaser', date: '2026-07-16' }

  const schemaWithFill: MetadataSchema = {
    fields: [
      { key: 'approved_by', label: 'Approved by', type: 'user', fillOnRelease: 'actor' },
      { key: 'approval_date', label: 'Approval date', type: 'date', fillOnRelease: 'date' },
    ],
  }

  /** Fake-Provider: `readFile` liefert den übergebenen Inhalt, `writeFile`
   *  merkt sich den letzten Aufruf (statt echtem IO), alles andere wirft. */
  function fakeProvider(content: string): { provider: GitProvider; writes: Array<{ path: string; content: string; sha?: string }> } {
    const writes: Array<{ path: string; content: string; sha?: string }> = []
    const unexpected = (): never => {
      throw new Error('unerwarteter Provider-Aufruf')
    }
    const provider: GitProvider = {
      readFile: async (_repo, p) => ({ path: p, content, sha: 'sha-1' }),
      writeFile: async (_repo, p, c, opts) => {
        writes.push({ path: p, content: c, sha: opts.sha })
        return { commitSha: 'sha-2' }
      },
      readFileBinary: unexpected, listTree: unexpected, getHeadSha: unexpected, writeFileBinary: unexpected,
      createBranch: unexpected, deleteBranch: unexpected, listCommits: unexpected, createPullRequest: unexpected,
      getPullRequest: unexpected, listPullRequests: unexpected, requestReviewers: unexpected,
      submitPullRequestReview: unexpected, mergePullRequest: unexpected,
    }
    return { provider, writes }
  }

  it('kein fillOnRelease-Feld im Schema → gar kein Provider-Aufruf (Kurzschluss)', async () => {
    const unexpected = (): never => {
      throw new Error('unerwarteter Provider-Aufruf')
    }
    const provider: GitProvider = {
      readFile: unexpected, readFileBinary: unexpected, listTree: unexpected, getHeadSha: unexpected,
      writeFile: unexpected, writeFileBinary: unexpected, createBranch: unexpected, deleteBranch: unexpected,
      listCommits: unexpected, createPullRequest: unexpected, getPullRequest: unexpected,
      listPullRequests: unexpected, requestReviewers: unexpected, submitPullRequestReview: unexpected,
      mergePullRequest: unexpected,
    }
    const schema: MetadataSchema = { fields: [{ key: 'process_id', label: 'Process ID', type: 'text' }] }
    await expect(
      fillReleaseMetadataOnDraft(provider, repo, path, branch, schema, values),
    ).resolves.toBeUndefined()
  })

  it('leere fillOnRelease-Felder werden vorbelegt und committet', async () => {
    const { provider, writes } = fakeProvider('---\ntitle: Seite\n---\n# Seite\n')
    await fillReleaseMetadataOnDraft(provider, repo, path, branch, schemaWithFill, values)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe(path)
    expect(writes[0]!.sha).toBe('sha-1')
    expect(writes[0]!.content).toContain('approved_by: Releaser')
    expect(writes[0]!.content).toContain('approval_date: 2026-07-16')
    expect(writes[0]!.content).toContain('# Seite')
  })

  it('bereits gesetzter Wert bleibt unverändert — KEIN Commit, wenn nichts zu füllen ist', async () => {
    const { provider, writes } = fakeProvider(
      '---\ntitle: Seite\napproved_by: Alice\napproval_date: 2026-01-01\n---\n# Seite\n',
    )
    await fillReleaseMetadataOnDraft(provider, repo, path, branch, schemaWithFill, values)
    expect(writes).toHaveLength(0)
  })

  it('nur EIN Feld leer → nur dieses wird gefüllt, das andere bleibt', async () => {
    const { provider, writes } = fakeProvider(
      '---\ntitle: Seite\napproved_by: Alice\n---\n# Seite\n',
    )
    await fillReleaseMetadataOnDraft(provider, repo, path, branch, schemaWithFill, values)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.content).toContain('approved_by: Alice')
    expect(writes[0]!.content).toContain('approval_date: 2026-07-16')
  })
})

/**
 * Seitenversionierung (Task 6, `POST /api/pages/:id/release`, `routes/workflow.ts`):
 * `applyVersionOnDraft` orchestriert wie `fillReleaseMetadataOnDraft` oben nur
 * `readFile`/`writeFile` auf einem GitProvider — reiner Fake statt Forgejo-
 * Container genügt. Der End-zu-Ende-Fall (echter Merge + `page_versions`-
 * Eintrag) ist `workflow-routes.test.ts`.
 */
describe('applyVersionOnDraft', () => {
  const repo: RepoRef = { provider: 'forgejo', owner: 'o', repo: 'r' }

  /** Fake-Provider mit `lastWrite()`-Bequemlichkeit — anders als die Tests
   *  oben interessiert hier nur der INHALT des letzten Schreibvorgangs, nicht
   *  seine Anzahl (jeder Aufruf von `applyVersionOnDraft` schreibt genau
   *  einmal, das ist bereits durch die Provider-Vertrags-Erwartung
   *  `sha: 'sha-1'` unten indirekt geprüft — ein zweiter Write würde mit dem
   *  dann veralteten `sha-1` gegen einen "echten" Provider scheitern). */
  function fakeProvider(content: string): GitProvider & { lastWrite: () => string } {
    let last: string | undefined
    const unexpected = (): never => {
      throw new Error('unerwarteter Provider-Aufruf')
    }
    return {
      readFile: async (_repo, p) => ({ path: p, content, sha: 'sha-1' }),
      writeFile: async (_repo, _p, c, opts) => {
        expect(opts.sha).toBe('sha-1')
        last = c
        return { commitSha: 'sha-2' }
      },
      lastWrite: () => {
        if (last === undefined) throw new Error('kein Write erfolgt')
        return last
      },
      readFileBinary: unexpected, listTree: unexpected, getHeadSha: unexpected, writeFileBinary: unexpected,
      createBranch: unexpected, deleteBranch: unexpected, listCommits: unexpected, createPullRequest: unexpected,
      getPullRequest: unexpected, listPullRequests: unexpected, requestReviewers: unexpected,
      submitPullRequestReview: unexpected, mergePullRequest: unexpected,
    }
  }

  it('setzt bei der ersten Freigabe 1.0.0 und legt den Changelog an', async () => {
    const provider = fakeProvider('---\ntitle: Handbuch\n---\n\n# Handbuch\n')

    const result = await applyVersionOnDraft(provider, repo, 'index.md', 'draft/p-1', undefined, {
      bump: 'minor',
      note: 'Erstfassung',
      author: 'D. Krcek',
      date: '2026-07-19',
    })

    expect(result.version).toBe('1.0.0')
    const written = provider.lastWrite()
    expect(written).toContain('version: 1.0.0')
    expect(written).toContain('note: Erstfassung')
  })

  it('rechnet vom übergebenen main-Stand, nicht vom Draft-Inhalt', async () => {
    // Draft trägt bereits 1.3.0 (fehlgeschlagener Merge eines Vorversuchs),
    // main steht auf 1.2.0 — die Zielversion muss trotzdem 1.3.0 sein,
    // nicht 1.4.0. Genau dieser Doppelsprung soll verhindert werden.
    const provider = fakeProvider('---\ntitle: X\nversion: 1.3.0\n---\n\n# X\n')

    const result = await applyVersionOnDraft(provider, repo, 'index.md', 'draft/p-1', '1.2.0', {
      bump: 'minor',
      note: 'Zweiter Versuch',
      author: 'D. Krcek',
      date: '2026-07-19',
    })

    expect(result.version).toBe('1.3.0')
  })

  it('überschreibt eine handgeschriebene Version im Draft', async () => {
    const provider = fakeProvider('---\ntitle: X\nversion: 9.9.9\n---\n\n# X\n')

    const result = await applyVersionOnDraft(provider, repo, 'index.md', 'draft/p-1', '1.0.0', {
      bump: 'patch',
      note: 'Korrektur',
      author: 'D. Krcek',
      date: '2026-07-19',
    })

    expect(result.version).toBe('1.0.1')
    expect(provider.lastWrite()).not.toContain('9.9.9')
  })

  it('kürzt den Changelog auf 10 Einträge', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      `  - version: 1.0.${i}\n    date: 2026-01-0${(i % 9) + 1}\n    author: A\n    note: N${i}`,
    ).join('\n')
    const provider = fakeProvider(`---\ntitle: X\nversion: 1.0.9\nchangelog:\n${entries}\n---\n\n# X\n`)

    await applyVersionOnDraft(provider, repo, 'index.md', 'draft/p-1', '1.0.9', {
      bump: 'patch', note: 'Neu', author: 'A', date: '2026-07-19',
    })

    const written = provider.lastWrite()
    expect(written.match(/- version:/g)).toHaveLength(10)
    expect(written).toContain('1.0.10')
  })

  const initialEntry = { version: '0.1.0', date: '2026-06-01', author: 'Grace', note: 'Initial version' }

  it('initialEntry: bumps from 0.1.0 and writes [new, 0.1.0] in one write', async () => {
    const provider = fakeProvider('---\ntitle: X\n---\n\n# X\n')

    const result = await applyVersionOnDraft(provider, repo, 'index.md', 'draft/p-1', '0.1.0', {
      bump: 'major', note: 'First release', author: 'A', date: '2026-10-02', initialEntry,
    })

    expect(result.version).toBe('1.0.0')
    const changelog = parsePage(provider.lastWrite()).frontmatter.changelog
    expect(changelog).toEqual([
      { version: '1.0.0', date: '2026-10-02', author: 'A', note: 'First release' },
      initialEntry,
    ])
  })

  it('initialEntry: a retry does not duplicate entries left in the draft', async () => {
    // Draft from a failed first attempt already carries both entries.
    const provider = fakeProvider(
      '---\ntitle: X\nversion: 0.2.0\nchangelog:\n'
        + '  - version: 0.2.0\n    date: 2026-10-01\n    author: A\n    note: Old try\n'
        + '  - version: 0.1.0\n    date: 2026-06-01\n    author: Grace\n    note: Initial version\n'
        + '---\n\n# X\n',
    )

    const result = await applyVersionOnDraft(provider, repo, 'index.md', 'draft/p-1', '0.1.0', {
      bump: 'minor', note: 'Second try', author: 'A', date: '2026-10-02', initialEntry,
    })

    expect(result.version).toBe('0.2.0')
    const changelog = parsePage(provider.lastWrite()).frontmatter.changelog
    expect(changelog?.map((e) => e.version)).toEqual(['0.2.0', '0.1.0'])
    expect(changelog?.[0]?.note).toBe('Second try')
  })
})
