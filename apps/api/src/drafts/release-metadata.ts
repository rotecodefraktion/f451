import type { GitProvider, RepoRef } from '@f451/git-provider'
import {
  computeFillOnReleaseValues,
  joinFrontmatter,
  nextVersion,
  parsePage,
  prependChangelogEntry,
  setFrontmatterMetadata,
  splitFrontmatter,
  type ChangelogEntry,
  type FillOnReleaseValues,
  type MetadataSchema,
  type VersionBump,
} from '@f451/markdown'

/**
 * Freigabe-Vorbelegung (Metadaten-Feature M3b Teil B, `POST /api/pages/:id/release`,
 * `routes/workflow.ts`): füllt `fillOnRelease`-Felder (s. `@f451/markdown#schema.ts`)
 * VOR dem Merge auf dem Draft-Branch auf, falls sie zu diesem Zeitpunkt leer
 * sind — der Merge nimmt den zusätzlichen Commit dadurch automatisch mit
 * (kein separater Schritt nötig, der Draft-Branch IST der PR-Head).
 *
 * Kurzschluss OHNE jeden Provider-Aufruf, wenn das Schema gar kein
 * `fillOnRelease`-Feld deklariert (der ganz überwiegende Regelfall — die
 * allermeisten Spaces haben entweder gar kein Schema oder keins mit dieser
 * Option): kein zusätzlicher `readFile`, kein `writeFile`, bestehendes
 * Release-Verhalten bleibt für sie exakt unverändert.
 *
 * Wirft NUR bei einem echten Provider-Fehler (Lesen/Schreiben des Draft-
 * Inhalts) — der Aufrufer (Route) fängt das über denselben äußeren
 * try/catch wie den Rest des Release-Ablaufs ab (502, s. `routes/workflow.ts`).
 * Zu diesem Zeitpunkt wurde noch NICHT gemergt — ein Fehler hier lässt die
 * Freigabe insgesamt fehlschlagen, statt einen halb befüllten/inkonsistenten
 * Merge zu riskieren; der Nutzer kann die Freigabe danach einfach erneut
 * versuchen.
 */
export async function fillReleaseMetadataOnDraft(
  provider: GitProvider,
  repo: RepoRef,
  path: string,
  branch: string,
  schema: MetadataSchema,
  values: FillOnReleaseValues,
): Promise<void> {
  const hasFillOnRelease = schema.fields.some(
    (f) => (f.type === 'user' && f.fillOnRelease === 'actor') || (f.type === 'date' && f.fillOnRelease === 'date'),
  )
  if (!hasFillOnRelease) return

  const file = await provider.readFile(repo, path, branch)
  const currentMetadata = parsePage(file.content).frontmatter.metadata ?? {}
  const fillValues = computeFillOnReleaseValues(schema, currentMetadata, values)
  if (Object.keys(fillValues).length === 0) return

  const { frontmatterRaw, body } = splitFrontmatter(file.content)
  const newContent = joinFrontmatter(setFrontmatterMetadata(frontmatterRaw, fillValues), body)
  await provider.writeFile(repo, path, newContent, {
    branch,
    message: 'Automatisch: Freigabe-Metadaten ergänzt (fillOnRelease)',
    sha: file.sha,
  })
}

/**
 * Setzt `version` und stellt einen `changelog`-Eintrag voran — auf dem
 * Draft-Branch, VOR dem Merge (der Draft-Branch IST der PR-Head, der Commit
 * wandert also automatisch in den Merge; kein zweiter Commit nötig).
 *
 * `mainVersion` ist die Version aus `main`, NICHT aus dem Draft: Scheitert ein
 * Merge, steht die erhöhte Version bereits im Draft — vom Draft gerechnet
 * spränge jeder Wiederholungsversuch eine Version weiter. Vom main-Stand
 * gerechnet ist der Vorgang wiederholbar.
 *
 * `version`/`changelog` im Draft werden dabei überschrieben: Beide Felder sind
 * systemverwaltet, sonst könnte sich jeder eine Wunschversion eintragen.
 */
export async function applyVersionOnDraft(
  provider: GitProvider,
  repo: RepoRef,
  path: string,
  branch: string,
  mainVersion: string | undefined,
  params: { bump: VersionBump; note: string; author: string; date: string },
): Promise<{ version: string; entry: ChangelogEntry }> {
  const version = nextVersion(mainVersion, params.bump)
  const entry: ChangelogEntry = {
    version,
    date: params.date,
    author: params.author,
    note: params.note,
  }

  const file = await provider.readFile(repo, path, branch)
  const existing = parsePage(file.content).frontmatter.changelog
  const { frontmatterRaw, body } = splitFrontmatter(file.content)
  // setFrontmatterMetadata ist bewusst generisch (s. dortiger Modulkommentar)
  // und setzt beliebige Top-Level-Schlüssel — auch die Kernfelder.
  const newFrontmatter = setFrontmatterMetadata(frontmatterRaw, {
    version,
    changelog: prependChangelogEntry(existing, entry),
  })
  await provider.writeFile(repo, path, joinFrontmatter(newFrontmatter, body), {
    branch,
    message: `Automatisch: Version ${version} (Freigabe)`,
    sha: file.sha,
  })

  return { version, entry }
}
