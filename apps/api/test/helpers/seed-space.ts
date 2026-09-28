import { ForgejoProvider, type RepoRef } from '@f451/git-provider'

/** Schreibt eine Datei auf main (POST = anlegen). Gemeinsamer Baustein für
 *  Integrationstests, die einen Forgejo-Container seeden (Task 3/6). */
export async function write(
  provider: ForgejoProvider,
  repo: RepoRef,
  path: string,
  content: string,
): Promise<void> {
  await provider.writeFile(repo, path, content, { branch: 'main', message: `seed: ${path}` })
}

/**
 * Seedet einen realistischen Wiki-Baum: 6 Seiten inkl. Unterordner, Wikilink,
 * relativem Link, kaputtem Link, Relation, Tags, einer Seite mit kaputtem
 * YAML und einer archivierten Seite. Basiert auf dem Fixture aus
 * `test/indexer.test.ts` (Task 3), als gemeinsamer Helper für die
 * Lese-API-Tests (Task 6) wiederverwendet und um Task 1c7 erweitert.
 */
export async function seedFixtureSpace(provider: ForgejoProvider, repo: RepoRef): Promise<void> {
  await write(provider, repo, 'index.md', `---
id: home
title: Startseite
lang: de
tags:
  - start
---
# Startseite

Siehe [[betrieb/deployment]] und den fehlenden [[gibt-es-nicht]].
`)

  await write(provider, repo, 'betrieb/index.md', `---
id: betrieb
title: Betrieb
lang: de
tags: [betrieb, wichtig]
relations:
  depends_on:
    - deployment
---
# Betrieb

Zum [[Monitoring]] siehe dort.
`)

  await write(provider, repo, 'betrieb/deployment/index.md', `---
id: deployment
title: Deployment
lang: de
tags: [ops]
---
# Deployment

Details zum Deployment. Siehe [Monitoring](../monitoring/index.md).

![Diagramm](./img/arch.png)
`)

  await write(provider, repo, 'betrieb/monitoring/index.md', `---
id: monitoring
title: Monitoring
lang: en
tags: [ops, observability]
---
# Monitoring

Observability and monitoring dashboards.
`)

  await write(provider, repo, 'betrieb/broken-yaml/index.md', `---
title: "Kaputt
tags: [a, b
---
# Kaputte Seite

Body-Text der kaputten Seite.
`)

  await write(provider, repo, 'betrieb/archiviert/index.md', `---
id: archiviert
title: Archiviert
lang: de
archived: true
tags: [ops]
---
# Archivierte Seite

Historischer Archivinhalt, der weiterhin über die Suche auffindbar bleiben muss.
`)
}
