import { describe, expect, it } from 'vitest'
import type { GitProvider, RepoRef } from '../src/types.js'
import { ConflictError, NotFoundError, ProviderError } from '../src/errors.js'

export interface ContractContext {
  provider: GitProvider
  repo: RepoRef
  /**
   * Zweiter Testnutzer für den "Review-Workflow"-Block: eigene, vom PR-Autor
   * (`provider`) verschiedene Identität mit Repo-Zugriff (Collaborator) — approved
   * als eigenständiger Nutzer statt als Autor. Nur nötig/gesetzt, wenn der
   * Aufrufer `supportsReviewWorkflow: true` übergibt (siehe `ContractSuiteOptions`).
   */
  reviewer?: { provider: GitProvider; username: string }
}

export interface ContractSuiteOptions {
  /**
   * Aktiviert den "Review-Workflow"-Block (`listPullRequests`, `requestReviewers`,
   * `submitPullRequestReview`, `mergeable`, Self-Review-Verbot). Braucht `ctx.reviewer`
   * aus `getContext()`. Default `false` — nicht jeder Testaufbau kann einen zweiten
   * echten Testnutzer bereitstellen (z. B. der env-gated GitHub-Live-Contract, der
   * nur einen einzelnen PAT hat; die drei Methoden sind dort stattdessen per
   * MockAgent-Unit-Test abgedeckt, siehe `github.unit.test.ts`).
   */
  supportsReviewWorkflow?: boolean
}

/** Pollt getPullRequest, bis `mergeable === true` oder das Budget ausgeschöpft ist,
 *  und liefert den zuletzt gesehenen Wert. WICHTIG: `false` ist KEIN Endzustand —
 *  Forgejo/Gitea melden `mergeable=false` bereits, WÄHREND der asynchrone
 *  Konflikt-Check noch läuft (gitea models/issues/pull.go: `Mergeable()` ist false
 *  bei Status „Checking"; die API kennt kein null). Ein Poll auf „non-null" bricht
 *  deshalb unter Docker-Last sofort mit false ab, obwohl der PR mergebar wird —
 *  genau so war dieser Helper zunächst gebaut und färbte die Suite maschinen-
 *  abhängig rot. Wie die Produktionslogik `forgejo.ts#waitUntilMergeable` wird
 *  daher bis `true` gepollt; ein echter Konflikt äußert sich als `false` nach
 *  ausgeschöpftem Budget. Exportiert für den Unit-Test der Poll-Logik
 *  (wait-mergeable.test.ts). */
export async function waitForMergeableResolved(
  provider: Pick<GitProvider, 'getPullRequest'>,
  repo: RepoRef,
  number: number,
  budgetMs = 15_000,
): Promise<boolean | null> {
  const deadline = Date.now() + budgetMs
  let delay = 200
  for (;;) {
    const pr = await provider.getPullRequest(repo, number)
    if (pr.mergeable === true) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return pr.mergeable
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)))
    delay *= 2
  }
}

/** Führt die vollständige Contract-Suite gegen eine Provider-Implementierung aus.
 *  getContext() muss ein frisches, auto-initialisiertes Repo (main + README.md) liefern.
 *  Die Tests innerhalb der Suite sind sequenziell und bauen aufeinander auf. */
export function runGitProviderContractTests(
  name: string,
  getContext: () => Promise<ContractContext>,
  opts: ContractSuiteOptions = {},
): void {
  describe.sequential(`GitProvider-Contract: ${name}`, () => {
    let ctx: ContractContext

    it('Setup: frisches Repo verfügbar', async () => {
      ctx = await getContext()
      expect(ctx.repo.owner).toBeTruthy()
    }, 180_000)

    it('readFile liest die README vom main-Branch', async () => {
      const f = await ctx.provider.readFile(ctx.repo, 'README.md', 'main')
      expect(f.path).toBe('README.md')
      expect(f.content.length).toBeGreaterThan(0)
      expect(f.sha).toMatch(/^[0-9a-f]{40}$/)
    })

    it('readFile wirft NotFoundError für fehlende Datei', async () => {
      await expect(ctx.provider.readFile(ctx.repo, 'gibt-es-nicht.md', 'main')).rejects.toBeInstanceOf(
        NotFoundError,
      )
    })

    it('writeFile legt eine neue Datei an (verschachtelter Pfad)', async () => {
      const res = await ctx.provider.writeFile(ctx.repo, 'betrieb/deployment/index.md', '# Deployment\n', {
        branch: 'main',
        message: 'docs: Deployment-Seite',
      })
      expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/)
      const f = await ctx.provider.readFile(ctx.repo, 'betrieb/deployment/index.md', 'main')
      expect(f.content).toBe('# Deployment\n')
    })

    it('writeFile aktualisiert mit korrektem SHA', async () => {
      const before = await ctx.provider.readFile(ctx.repo, 'betrieb/deployment/index.md', 'main')
      await ctx.provider.writeFile(ctx.repo, 'betrieb/deployment/index.md', '# Deployment v2\n', {
        branch: 'main',
        message: 'docs: v2',
        sha: before.sha,
      })
      const after = await ctx.provider.readFile(ctx.repo, 'betrieb/deployment/index.md', 'main')
      expect(after.content).toBe('# Deployment v2\n')
      expect(after.sha).not.toBe(before.sha)
    })

    it('writeFile mit veraltetem SHA wirft ConflictError', async () => {
      await expect(
        ctx.provider.writeFile(ctx.repo, 'betrieb/deployment/index.md', '# Konflikt\n', {
          branch: 'main',
          message: 'docs: konflikt',
          sha: '0000000000000000000000000000000000000000',
        }),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('deleteFile löscht eine Datei; readFile darauf wirft NotFoundError', async () => {
      await ctx.provider.writeFile(ctx.repo, 'betrieb/loeschen/index.md', '# Löschen\n', {
        branch: 'main',
        message: 'docs: Löschkandidat',
      })
      const before = await ctx.provider.readFile(ctx.repo, 'betrieb/loeschen/index.md', 'main')

      const res = await ctx.provider.deleteFile(ctx.repo, 'betrieb/loeschen/index.md', {
        branch: 'main',
        message: 'docs: Löschkandidat entfernen',
        sha: before.sha,
      })
      expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/)

      await expect(
        ctx.provider.readFile(ctx.repo, 'betrieb/loeschen/index.md', 'main'),
      ).rejects.toBeInstanceOf(NotFoundError)
    })

    it('deleteFile mit veraltetem SHA wirft ConflictError', async () => {
      await ctx.provider.writeFile(ctx.repo, 'betrieb/loeschen-konflikt/index.md', '# Konflikt\n', {
        branch: 'main',
        message: 'docs: Löschkandidat (Konflikt)',
      })
      await expect(
        ctx.provider.deleteFile(ctx.repo, 'betrieb/loeschen-konflikt/index.md', {
          branch: 'main',
          message: 'docs: löschen',
          sha: '0000000000000000000000000000000000000000',
        }),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('readFileBinary liefert byte-identischen Buffer zu Buffer.from(content, "utf8")', async () => {
      const content = 'Sonderbytes: äöü ß € 中文 🎉\r\nZeile mit Tab\t und Zeilenumbruch\n'
      await ctx.provider.writeFile(ctx.repo, 'medien/sonderbytes.txt', content, {
        branch: 'main',
        message: 'docs: Sonderbytes-Datei',
      })
      const bin = await ctx.provider.readFileBinary(ctx.repo, 'medien/sonderbytes.txt', 'main')
      expect(bin.content).toEqual(Buffer.from(content, 'utf8'))
      expect(bin.sha).toMatch(/^[0-9a-f]{40}$/)
    })

    it('writeFileBinary/readFileBinary round-trip: keine UTF-8-Verlustkodierung (echte PNG-Magic-Bytes)', async () => {
      // Bewusst Bytes, die als UTF-8 KEINE gültige Zeichenkette wären (0x89 als
      // erstes Byte, ungültige Fortsetzungsbytes) — genau der Fall, in dem
      // `writeFile` (Buffer.from(content, 'utf8')) Bytes verlustbehaftet
      // verändern würde (Ersetzungszeichen U+FFFD). `writeFileBinary` muss die
      // Bytes unverändert durchreichen (Phase 2a Task 5, Media-Upload: PNG/JPEG-
      // Uploads dürfen beim Commit nicht korrumpiert werden).
      const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])
      await ctx.provider.writeFileBinary(ctx.repo, 'medien/bild.png', content, {
        branch: 'main',
        message: 'docs: Binärdatei',
      })
      const bin = await ctx.provider.readFileBinary(ctx.repo, 'medien/bild.png', 'main')
      expect(bin.content).toEqual(content)
      expect(bin.sha).toMatch(/^[0-9a-f]{40}$/)
    })

    it('listTree liefert Dateien und Verzeichnisse rekursiv', async () => {
      const tree = await ctx.provider.listTree(ctx.repo, 'main')
      const paths = tree.map((t) => t.path)
      expect(paths).toContain('README.md')
      expect(paths).toContain('betrieb/deployment/index.md')
      const dir = tree.find((t) => t.path === 'betrieb')
      expect(dir?.type).toBe('dir')
    })

    it('commitFiles schreibt und löscht mehrere Dateien in EINEM Commit', async () => {
      // Der Vertrag, um dessentwillen es die Methode gibt: Ein Seiten-Move mit
      // Unterseiten und Anhängen erzeugte über die Einzelmethoden 400 Commits
      // und brauchte drei Minuten (gemessen 2026-07-28). Geprüft wird deshalb
      // nicht nur, DASS die Dateien ankommen, sondern dass dabei genau EIN
      // Commit entsteht — sonst wäre die Methode nur eine Schleife mit
      // anderem Namen.
      await ctx.provider.writeFile(ctx.repo, 'sammel/alt.md', '# Alt\n', {
        branch: 'main',
        message: 'docs: Sammel-Vorbereitung',
      })
      const alt = await ctx.provider.readFile(ctx.repo, 'sammel/alt.md', 'main')
      const vorher = await ctx.provider.getHeadSha(ctx.repo, 'main')

      const res = await ctx.provider.commitFiles(
        ctx.repo,
        [
          { op: 'write', path: 'sammel/neu-a.md', content: Buffer.from('# Neu A\n', 'utf8') },
          { op: 'write', path: 'sammel/neu-b.md', content: Buffer.from('# Neu B\n', 'utf8') },
          // Binärsicher: dieselben Bytes müssen zurückkommen, nicht eine
          // UTF-8-Interpretation davon (PNG-Magic-Bytes).
          { op: 'write', path: 'sammel/bild.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
          { op: 'delete', path: 'sammel/alt.md', sha: alt.sha },
        ],
        { branch: 'main', message: 'docs: Sammel-Commit' },
      )
      expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/)

      expect((await ctx.provider.readFile(ctx.repo, 'sammel/neu-a.md', 'main')).content).toBe('# Neu A\n')
      expect((await ctx.provider.readFile(ctx.repo, 'sammel/neu-b.md', 'main')).content).toBe('# Neu B\n')
      const bild = await ctx.provider.readFileBinary(ctx.repo, 'sammel/bild.png', 'main')
      expect([...bild.content]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      await expect(ctx.provider.readFile(ctx.repo, 'sammel/alt.md', 'main')).rejects.toBeInstanceOf(NotFoundError)

      // Vier Änderungen, ein Commit — genau das ist die Zusage.
      const commits = await ctx.provider.listCommits(ctx.repo, { ref: 'main', limit: 20 })
      const seitVorher = commits.findIndex((c) => c.sha === vorher)
      expect(seitVorher).toBe(1)
    })

    it('commitFiles ohne Änderungen erzeugt keinen Commit', async () => {
      // „Nichts zu tun" ist ein gültiger Aufruf — jeder Aufrufer müsste sonst
      // dieselbe Sonderbehandlung selbst schreiben.
      const vorher = await ctx.provider.getHeadSha(ctx.repo, 'main')
      const res = await ctx.provider.commitFiles(ctx.repo, [], { branch: 'main', message: 'docs: leer' })
      expect(res.commitSha).toBeNull()
      expect(await ctx.provider.getHeadSha(ctx.repo, 'main')).toBe(vorher)
    })

    it('getHeadSha ändert sich nach einem Commit', async () => {
      const h1 = await ctx.provider.getHeadSha(ctx.repo, 'main')
      await ctx.provider.writeFile(ctx.repo, 'notiz.md', 'kurz\n', {
        branch: 'main',
        message: 'docs: notiz',
      })
      const h2 = await ctx.provider.getHeadSha(ctx.repo, 'main')
      expect(h1).toMatch(/^[0-9a-f]{40}$/)
      expect(h2).not.toBe(h1)
    })

    it('listCommits liefert Historie für einen Pfad, neueste zuerst', async () => {
      const commits = await ctx.provider.listCommits(ctx.repo, {
        ref: 'main',
        path: 'betrieb/deployment/index.md',
        limit: 10,
      })
      expect(commits.length).toBeGreaterThanOrEqual(2)
      expect(commits[0]!.message).toContain('v2')
      expect(commits[0]!.authorEmail).toBeTruthy()
      expect(Date.parse(commits[0]!.date)).not.toBeNaN()
    })

    it('Draft-Workflow: Branch → Commit → PR → Merge → Datei auf main', async () => {
      await ctx.provider.createBranch(ctx.repo, 'draft/8f3ka2', 'main')
      await ctx.provider.writeFile(ctx.repo, 'betrieb/monitoring/index.md', '# Monitoring\n', {
        branch: 'draft/8f3ka2',
        message: 'docs: Monitoring-Entwurf',
      })
      const pr = await ctx.provider.createPullRequest(ctx.repo, {
        head: 'draft/8f3ka2',
        base: 'main',
        title: 'Monitoring',
        body: 'Neue Seite',
      })
      expect(pr.state).toBe('open')
      expect(pr.headBranch).toBe('draft/8f3ka2')

      const fetched = await ctx.provider.getPullRequest(ctx.repo, pr.number)
      expect(fetched.number).toBe(pr.number)

      const merged = await ctx.provider.mergePullRequest(ctx.repo, pr.number)
      expect(merged.mergeSha).toMatch(/^[0-9a-f]{40}$/)
      const f = await ctx.provider.readFile(ctx.repo, 'betrieb/monitoring/index.md', 'main')
      expect(f.content).toBe('# Monitoring\n')
      const prAfter = await ctx.provider.getPullRequest(ctx.repo, pr.number)
      expect(prAfter.state).toBe('merged')
    }, 60_000)

    it('deleteBranch entfernt den Draft-Branch; getHeadSha darauf wirft NotFoundError', async () => {
      await ctx.provider.deleteBranch(ctx.repo, 'draft/8f3ka2')
      await expect(ctx.provider.getHeadSha(ctx.repo, 'draft/8f3ka2')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('getPullRequest wirft NotFoundError für unbekannte Nummer', async () => {
      await expect(ctx.provider.getPullRequest(ctx.repo, 999999)).rejects.toBeInstanceOf(NotFoundError)
    })

    it.skipIf(!opts.supportsReviewWorkflow)(
      'Review-Workflow: PR → Reviewer anfragen → Review abgeben → mergeable → Self-Review-Verbot → Merge',
      async () => {
        const reviewer = ctx.reviewer
        if (!reviewer) throw new Error('supportsReviewWorkflow=true erfordert ctx.reviewer aus getContext()')

        await ctx.provider.createBranch(ctx.repo, 'draft/review-1', 'main')
        await ctx.provider.writeFile(ctx.repo, 'betrieb/backup/index.md', '# Backup\n', {
          branch: 'draft/review-1',
          message: 'docs: Backup-Entwurf',
        })
        const pr = await ctx.provider.createPullRequest(ctx.repo, {
          head: 'draft/review-1',
          base: 'main',
          title: 'Backup',
          body: 'Neue Seite',
        })

        // listPullRequests({head}) findet ihn; state:'open'-Filter greift.
        const found = await ctx.provider.listPullRequests(ctx.repo, { head: 'draft/review-1', state: 'open' })
        expect(found.map((p) => p.number)).toContain(pr.number)

        // Zweiter Testnutzer wird als Reviewer zugewiesen.
        await ctx.provider.requestReviewers(ctx.repo, pr.number, [reviewer.username])

        // Der zweite Nutzer approved — NICHT der Autor (dessen Self-Approve wird
        // unten separat als erwarteter Fehlerfall geprüft).
        await reviewer.provider.submitPullRequestReview(ctx.repo, pr.number, {
          event: 'approve',
          body: 'LGTM',
        })

        // mergeable wird providerseitig asynchron berechnet — pollen statt
        // sofort anzunehmen (gleiches Muster wie mergePullRequest intern nutzt).
        const mergeable = await waitForMergeableResolved(ctx.provider, ctx.repo, pr.number)
        expect(mergeable).toBe(true)

        // Self-Review-Verbot: der PR-AUTOR darf den eigenen PR nicht approven —
        // erwarteter Fehlerfall, Provider lehnen das ab (Forgejo: "Poster of PR
        // can not approve own PR", i. d. R. 403). Wir prüfen bewusst nur den
        // Fehlertyp, nicht den exakten Status — der ist providerspezifisch, der
        // Vertrag garantiert nur "irgendein ProviderError".
        await expect(
          ctx.provider.submitPullRequestReview(ctx.repo, pr.number, { event: 'approve' }),
        ).rejects.toBeInstanceOf(ProviderError)

        await ctx.provider.mergePullRequest(ctx.repo, pr.number)

        const afterMerge = await ctx.provider.listPullRequests(ctx.repo, {
          head: 'draft/review-1',
          state: 'open',
        })
        expect(afterMerge).toHaveLength(0)
      },
      60_000,
    )
  })
}
