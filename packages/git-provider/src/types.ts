/** Referenz auf ein Repository bei einem konkreten Provider. */
export interface RepoRef {
  provider: 'forgejo' | 'github'
  owner: string
  repo: string
}

/** Eine gelesene Datei mit ihrem Blob-SHA (für konfliktsichere Updates). */
export interface GitFile {
  path: string
  /** UTF-8-dekodierter Inhalt. */
  content: string
  sha: string
}

/** Eintrag des rekursiven Repo-Baums. */
export interface TreeEntry {
  path: string
  type: 'file' | 'dir'
  sha: string
}

/** Ein Commit in der Historie einer Datei oder eines Refs. */
export interface CommitInfo {
  sha: string
  message: string
  authorName: string
  authorEmail: string
  /** ISO-8601. */
  date: string
}

export interface PullRequestInfo {
  number: number
  state: 'open' | 'merged' | 'closed'
  title: string
  headBranch: string
  baseBranch: string
  url: string
  /** `null` = der Provider berechnet die Mergebarkeit noch bzw. sie ist (noch)
   *  unbekannt (Forgejo: `mergeable`-Feld fehlt/ist `null`; GitHub: `mergeable`
   *  ist `true`/`false`/`null`). Beide Provider füllen dieses Feld verlässlich
   *  in `getPullRequest`; `createPullRequest`/`listPullRequests` dürfen `null`
   *  liefern, da der Provider die Berechnung dort typischerweise noch nicht
   *  abgeschlossen hat. */
  mergeable: boolean | null
}

/**
 * Eine Änderung innerhalb eines Sammel-Commits ({@link GitProvider.commitFiles}).
 *
 * `content` ist bei `write` immer ein Buffer — der Aufrufer entscheidet, wie er
 * seinen Text kodiert. Das ist Absicht: Die getrennten Wege `writeFile` (Text)
 * und `writeFileBinary` (Bytes) existieren, weil `Buffer.from(text, 'utf8')`
 * für binäre Inhalte verlustbehaftet ist; ein Sammel-Commit trägt beides
 * gemischt und kann die Entscheidung deshalb nicht selbst treffen.
 *
 * `sha` ist der bekannte Blob-SHA: bei `delete` Pflicht, bei `write` nur, wenn
 * eine bestehende Datei ersetzt wird.
 */
export type FileChange =
  | { op: 'write'; path: string; content: Buffer; sha?: string }
  | { op: 'delete'; path: string; sha: string }

/** Einheitlicher Vertrag über Forgejo und GitHub. Alle Methoden werfen
 *  NotFoundError/ConflictError/ProviderError gemäß Fehlerkontrakt. */
export interface GitProvider {
  /** Liest eine Datei unter einem Ref (Branch, Tag oder Commit-SHA). */
  readFile(repo: RepoRef, path: string, ref: string): Promise<GitFile>
  /** Liest eine Datei binärsicher unter einem Ref (Branch, Tag oder Commit-SHA) —
   *  KEIN UTF-8-Dekodieren, für Nicht-Text-Inhalte wie Bilder (Media-Auslieferung). */
  readFileBinary(repo: RepoRef, path: string, ref: string): Promise<{ content: Buffer; sha: string }>
  /** Listet den vollständigen Baum eines Refs rekursiv (Dateien und Verzeichnisse). */
  listTree(repo: RepoRef, ref: string): Promise<TreeEntry[]>
  /** Liefert den HEAD-Commit-SHA eines Branches. */
  getHeadSha(repo: RepoRef, branch: string): Promise<string>
  /** Legt eine Datei an oder aktualisiert sie. Bei Update MUSS `sha` (Blob-SHA des
   *  bekannten Standes) übergeben werden; bei Abweichung wirft der Provider ConflictError. */
  writeFile(
    repo: RepoRef,
    path: string,
    content: string,
    opts: { branch: string; message: string; sha?: string },
  ): Promise<{ commitSha: string }>
  /** Wie `writeFile`, aber binärsicher (Phase 2a Task 5, Media-Upload): `content` wird
   *  DIREKT base64-kodiert, statt (wie bei `writeFile`) zuerst als UTF-8-Text
   *  interpretiert zu werden. `writeFile` ist für Nicht-UTF-8-Bytes (z. B. PNG/JPEG-
   *  Magic-Bytes) verlustbehaftet — `Buffer.from(content, 'utf8')` einer aus binären
   *  Bytes gebauten JS-Zeichenkette rekonstruiert die ursprünglichen Bytes NICHT
   *  zuverlässig. Symmetrisches Gegenstück zu `readFileBinary`. */
  writeFileBinary(
    repo: RepoRef,
    path: string,
    content: Buffer,
    opts: { branch: string; message: string; sha?: string },
  ): Promise<{ commitSha: string }>
  /** Löscht eine Datei per Commit ("Seite löschen"-Feature). `sha` ist PFLICHT
   *  (aktueller Blob-SHA, wie bei `writeFile`s Update-Fall) — sowohl die
   *  Forgejo- als auch die GitHub-Contents-API verlangen ihn beim Löschen,
   *  sonst 404/422. Wirft `NotFoundError`, wenn die Datei nicht existiert,
   *  `ConflictError` bei abweichendem `sha`. */
  deleteFile(
    repo: RepoRef,
    path: string,
    opts: { branch: string; message: string; sha: string },
  ): Promise<{ commitSha: string }>
  /**
   * Schreibt und löscht mehrere Dateien in EINEM Commit.
   *
   * Der Grund ist gemessen: Ein Seiten-Move mit Unterseiten und deren Bildern
   * erzeugte über die Einzelmethoden 400 Commits und brauchte drei Minuten —
   * zweieinhalb Commits pro Sekunde, jeder ein eigener HTTP-Roundtrip. Der
   * Browser gab lange vorher auf, während der Server weiterarbeitete. Als
   * Sammel-Commit wird daraus ein Roundtrip.
   *
   * Der Aufrufer darf große Mengen übergeben; die Aufteilung in mehrere
   * Commits (Anfragegröße!) übernimmt die Implementierung. Zurückgegeben wird
   * der SHA des LETZTEN erzeugten Commits.
   *
   * Leere Liste = kein Commit, kein Fehler (`commitSha: null`) — das erspart
   * jedem Aufrufer die Sonderbehandlung „nichts zu tun".
   */
  commitFiles(
    repo: RepoRef,
    changes: FileChange[],
    opts: { branch: string; message: string },
  ): Promise<{ commitSha: string | null }>
  /** Erzeugt einen Branch vom HEAD eines bestehenden Branches. */
  createBranch(repo: RepoRef, name: string, fromBranch: string): Promise<void>
  deleteBranch(repo: RepoRef, name: string): Promise<void>
  /** Commit-Historie, optional auf einen Pfad eingeschränkt, neueste zuerst. */
  listCommits(repo: RepoRef, opts: { ref: string; path?: string; limit?: number }): Promise<CommitInfo[]>
  createPullRequest(
    repo: RepoRef,
    opts: { head: string; base: string; title: string; body?: string },
  ): Promise<PullRequestInfo>
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo>
  /** Sucht PRs, optional gefiltert nach Quell-/Ziel-Branch und Zustand
   *  (Default providerseitig i. d. R. `'open'`). Alle Felder von `opts` sind
   *  optional, `opts` selbst ist es NICHT — Aufrufer übergeben explizit `{}`
   *  für "keine Filter". */
  listPullRequests(
    repo: RepoRef,
    opts: { head?: string; base?: string; state?: 'open' | 'closed' | 'all' },
  ): Promise<PullRequestInfo[]>
  /** Fordert Reviews von den genannten Nutzern an (Login-Namen). */
  requestReviewers(repo: RepoRef, number: number, reviewers: string[]): Promise<void>
  /** Gibt eine Review zu einem PR ab. `request_changes` fordert Änderungen an,
   *  `approve` billigt den PR. Provider lehnen ein Self-Approve des PR-Autors
   *  typischerweise ab (ProviderError). */
  submitPullRequestReview(
    repo: RepoRef,
    number: number,
    opts: { event: 'approve' | 'request_changes'; body?: string },
  ): Promise<void>
  /** Merge per Merge-Commit. Wirft ConflictError, wenn nicht mergebar. */
  mergePullRequest(repo: RepoRef, number: number): Promise<{ mergeSha: string }>
}
