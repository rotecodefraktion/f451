# @f451/git-provider

Ein Vertrag (`GitProvider`), zwei Implementierungen: `ForgejoProvider` und `GitHubProvider`.
Beide sprechen dieselbe API (readFile/writeFile/listTree/Branches/PRs/Commits) und werfen
denselben Fehlerkontrakt, damit die Wiki-App provider-agnostisch bleibt.

## Verwendung

```ts
import { ForgejoProvider, GitHubProvider, ConflictError } from '@f451/git-provider'

const forgejo = new ForgejoProvider({ baseUrl: 'https://git.firma.de', token })
const github = new GitHubProvider({ token }) // baseUrl optional, Default api.github.com

const repo = { provider: 'forgejo', owner: 'acme', repo: 'wiki' } as const

const file = await forgejo.readFile(repo, 'docs/intro.md', 'main')

try {
  await forgejo.writeFile(repo, 'docs/intro.md', neuerInhalt, {
    branch: 'main',
    message: 'docs: intro aktualisieren',
    sha: file.sha, // bekannter Stand — bei Abweichung: ConflictError
  })
} catch (err) {
  if (err instanceof ConflictError) {
    // Autosave-409-Flow: Nutzer muss neu laden/mergen (Spec Abschnitt 9)
  }
}
```

## Tests

- **Contract-Suite (lokal, Forgejo-Container):** `pnpm test` startet Forgejo per Testcontainers
  und läuft in CI bei jedem Push/PR automatisch mit. Podman-Nutzer:innen brauchen die
  Env-Vars aus dem Root-README (`DOCKER_HOST` + `TESTCONTAINERS_RYUK_DISABLED=true`).
- **GitHub Live-Contract (manuell, destruktiv-additiv):**
  `GITHUB_CONTRACT=1 GITHUB_CONTRACT_TOKEN=… GITHUB_CONTRACT_REPO=owner/repo pnpm --filter @f451/git-provider test:contract:github`
  **Warnung:** Das Ziel-Repo muss frisch/auto-initialisiert sein (main + README) — der Lauf
  legt Branches, Dateien und PRs an und ist additiv, nicht isoliert. Kein Produktiv-Repo verwenden.
  In CI läuft dieser Test nur manuell via `workflow_dispatch` (Input `github_live_contract`,
  Secrets `GH_CONTRACT_TOKEN`/`GH_CONTRACT_REPO`).

## Fehlerkontrakt

| HTTP-Status      | Fehlertyp       | Bedeutung                                  |
| ----------------- | --------------- | ------------------------------------------- |
| 404                | `NotFoundError`  | Datei/Branch/PR/Repo existiert nicht        |
| 409                | `ConflictError`  | SHA-Konflikt beim Schreiben, PR nicht mergebar |
| 422 (GitHub)       | `ConflictError`  | GitHub meldet SHA-Mismatches als 422, gilt als Konflikt |
| sonstiger Fehler   | `ProviderError`  | Basisklasse, trägt `status` und `body`      |
