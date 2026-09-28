import { eq } from 'drizzle-orm'
import type { GitProvider, RepoRef } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { locks, pages } from '../db/schema.js'
import { branchExists, discardDraft } from './lifecycle.js'
import { draftBranchName } from './branch-name.js'

export interface DeletePageDeps {
  db: Db
}

/**
 * Löscht eine Seite vollständig (Feature „Seite löschen"): committet die
 * Löschung der Markdown-Datei DIREKT auf `main` (bewusst KEIN Review-Umweg,
 * s. Routen-Kommentar), verwirft einen offenen Draft-Branch samt dessen
 * Index-/Lock-Zeilen über das bestehende `discardDraft` (`drafts/lifecycle.ts`,
 * dieselbe Funktion wie „Entwurf verwerfen" — kein zweiter Aufräum-Mechanismus)
 * UND entfernt abschließend die verbleibende `ref='main'`-Indexzeile (die
 * `discardDraft` bewusst nicht anfasst, s. dessen Kopfkommentar). `tags`/
 * `edges` räumen sich dabei per FK-`CASCADE` automatisch mit auf (s.
 * `db/schema.ts`).
 *
 * Toleriert eine fehlende main-Datei (`NotFoundError` von `readFile`): eine
 * Draft-only-Seite (noch nie released, s. `resolveWriteContext`s Fallback)
 * hat nichts auf `main` zu löschen — dann räumt diese Funktion nur den
 * Draft-/Index-/Lock-Zustand auf.
 */
export async function deletePage(
  deps: DeletePageDeps,
  provider: GitProvider,
  repo: RepoRef,
  pageId: string,
  pagePath: string,
): Promise<void> {
  try {
    const file = await provider.readFile(repo, pagePath, 'main')
    await provider.deleteFile(repo, pagePath, {
      branch: 'main',
      message: `docs: „${pagePath}" löschen`,
      sha: file.sha,
    })
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err
  }

  // `discardDraft` wirft NotFoundError, wenn kein Draft-Branch existiert — hier
  // ist das kein Fehlerfall (die meisten gelöschten Seiten haben keinen
  // offenen Entwurf), deshalb vorab prüfen statt den Wurf abzufangen.
  if (await branchExists(provider, repo, draftBranchName(pageId))) {
    await discardDraft({ db: deps.db }, provider, repo, pageId)
  }

  // `discardDraft` räumt nur `ref='draft'` auf (s. dessen Kopfkommentar) — die
  // `ref='main'`-Zeile (bzw. ein evtl. verwaister Lock ohne Draft-Branch)
  // muss diese Funktion selbst entfernen.
  await deps.db.delete(pages).where(eq(pages.id, pageId))
  await deps.db.delete(locks).where(eq(locks.pageId, pageId))
}
