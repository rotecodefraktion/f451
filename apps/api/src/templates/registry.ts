import type { GitProvider, RepoRef, TreeEntry } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { parsePage, splitFrontmatter, stringifyFrontmatterBlock } from '@f451/markdown'
import type { GlobalTemplatesConfig, SpaceConfig } from '../spaces/config.js'

/** Verzeichnis für Vorlagen (Spec §6) — NICHT indexiert (der Indexer matcht
 *  nur `index.md`, siehe `indexer/index-space.ts#isPageFile`), daher dieses
 *  eigene, kleine Registry-Modul statt einer Erweiterung des Indexers. */
export const TEMPLATES_DIR = '_templates/'

export interface TemplateSummary {
  id: string
  name: string
  description: string
  source: 'space' | 'global'
}

export interface TemplatesDeps {
  providerRegistry: (space: SpaceConfig) => GitProvider
  globalTemplates?: GlobalTemplatesConfig
}

/** Id-Teil (Dateiname ohne `.md`) — NUR Kleinbuchstaben/Ziffern/`.`/`_`/`-`,
 *  ohne `..` (Pfad-Traversal-Schutz, die Id fließt in `readFile`-Pfade).
 *  Templates, deren Dateiname selbst nicht auf dieses Muster passt, werden in
 *  `listTemplates` trotzdem gelistet (die Id entsteht dort aus dem echten
 *  Dateinamen); `readTemplateBody` lehnt eine per API angefragte Id ab, die
 *  nicht durch dieses Muster geht. */
const TEMPLATE_ID_PATTERN = /^[a-z0-9._-]+$/

function isTemplateFile(entry: TreeEntry): boolean {
  if (entry.type !== 'file') return false
  if (!entry.path.startsWith(TEMPLATES_DIR)) return false
  if (!entry.path.endsWith('.md')) return false
  // Keine Unterordner unter _templates/ (YAGNI) — der Rest nach dem Präfix
  // darf außer dem '.md'-Suffix kein weiteres '/' enthalten.
  const rest = entry.path.slice(TEMPLATES_DIR.length)
  return !rest.includes('/')
}

/** Dateipfad → Id-Teil (Dateiname ohne Verzeichnis-Präfix und `.md`-Suffix). */
function fileNameToIdPart(path: string): string {
  return path.slice(TEMPLATES_DIR.length, -'.md'.length)
}

/** Id-Teil → Dateipfad im Space-Repo, z. B. `templatePath('meeting-notiz')` →
 *  `_templates/meeting-notiz.md`. Geteilt zwischen Lese- (`readTemplateBody`)
 *  und Schreibpfaden (POST/PATCH/DELETE in `routes/templates.ts`). */
export function templatePath(idPart: string): string {
  return `${TEMPLATES_DIR}${idPart}.md`
}

export interface ParsedTemplateId {
  source: 'space' | 'global'
  idPart: string
}

/** Zerlegt eine Vorlagen-Id (`<source>:<dateiname-ohne-md>`, s. `listTemplates`)
 *  in Quelle und Id-Teil und validiert Letzteren gegen `TEMPLATE_ID_PATTERN`
 *  (Pfad-Traversal-Schutz — der Id-Teil fließt direkt in `readFile`/
 *  `writeFile`/`deleteFile`-Pfade). `null` bei jeder Art von ungültiger Id:
 *  fehlender Doppelpunkt, unbekannte Quelle, verbotene Zeichen im Id-Teil.
 *  Geteilt zwischen `readTemplateBody` und den PATCH/DELETE-Routen
 *  (`routes/templates.ts`) — beide behandeln eine so ungültige Id wie eine
 *  unbekannte (kein Existenz-Orakel, s. Modul-Kommentar `readTemplateBody`). */
export function parseTemplateId(templateId: string): ParsedTemplateId | null {
  const sepIdx = templateId.indexOf(':')
  if (sepIdx === -1) return null
  const source = templateId.slice(0, sepIdx)
  const idPart = templateId.slice(sepIdx + 1)
  if (source !== 'space' && source !== 'global') return null
  if (!TEMPLATE_ID_PATTERN.test(idPart) || idPart.includes('..')) return null
  return { source, idPart }
}

export interface TemplateContent {
  name: string
  description?: string
  body: string
}

/** Baut den vollständigen `_templates/<id>.md`-Dateiinhalt (Frontmatter
 *  `title`/`description` + Body) aus Name/Beschreibung/Body — geteilter
 *  Baustein für Anlegen (POST) und Bearbeiten (PATCH) einer Space-Vorlage,
 *  damit beide Pfade exakt dasselbe Format erzeugen. Verhalten 1:1 aus dem
 *  bisherigen POST-Handler übernommen (kein Verhaltenswechsel für POST). */
export function buildTemplateFileContent(content: TemplateContent): string {
  const { name, description, body } = content
  const frontmatterBlock = stringifyFrontmatterBlock(
    description !== undefined ? { title: name, description } : { title: name },
  )
  const rawBody = splitFrontmatter(body).body.trimStart()
  const normalizedBody = rawBody.endsWith('\n') ? rawBody : `${rawBody}\n`
  return `---\n${frontmatterBlock}\n---\n\n${normalizedBody}`
}

/** Schreibt eine Space-Vorlage IN PLACE (gleicher Id-Teil/Dateiname) neu —
 *  Inhalt und/oder Beschreibung geändert, der Name (und damit der Pfad)
 *  bleibt gleich. `sha` ist der Blob-SHA des bekannten Standes
 *  (konfliktsicheres Update, wie bei jedem `writeFile`-Aufruf im Projekt).
 *  Läuft — wie `writeFile` hier immer — MIT dem übergebenen `provider`; der
 *  Aufrufer (PATCH-Route) reicht den NUTZER-Provider aus dem Schreib-Gate
 *  durch, NICHT die Service-Account-`providerRegistry` aus `TemplatesDeps`
 *  (die bleibt dem Lesepfad vorbehalten, s. `TemplatesDeps`-Kommentar in
 *  `routes/templates.ts`). */
export async function writeTemplateBody(
  provider: GitProvider,
  repoRef: RepoRef,
  idPart: string,
  content: TemplateContent,
  opts: { sha: string; message: string },
): Promise<{ commitSha: string }> {
  return provider.writeFile(repoRef, templatePath(idPart), buildTemplateFileContent(content), {
    branch: 'main',
    message: opts.message,
    sha: opts.sha,
  })
}

/** Benennt eine Space-Vorlage um (Namensänderung → neuer Slug/Dateiname):
 *  legt zuerst die neue Datei an (`writeFile` OHNE `sha` — reine Anlage, der
 *  Aufrufer hat die Ziel-Kollision bereits geprüft) und löscht danach die
 *  alte (`deleteFile`, mit `opts.oldSha` des bekannten Standes). Zwei
 *  getrennte Commits, kein atomarer Git-Vorgang — bricht der Prozess
 *  zwischen beiden Schritten ab (Netzwerkfehler o. Ä.), bleiben im
 *  schlimmsten Fall BEIDE Dateien bestehen (alte + neue). Bewusst in Kauf
 *  genommenes, seltenes Fenster — dieselbe Klasse Kompromiss wie andere
 *  Mehrschritt-Commit-Abläufe im Projekt (z. B. Draft-Branch-Erzeugung +
 *  erster Commit), kein Rollback-Mechanismus vorhanden. */
export async function renameTemplate(
  provider: GitProvider,
  repoRef: RepoRef,
  oldIdPart: string,
  newIdPart: string,
  content: TemplateContent,
  opts: { oldSha: string; name: string },
): Promise<{ commitSha: string }> {
  await provider.writeFile(repoRef, templatePath(newIdPart), buildTemplateFileContent(content), {
    branch: 'main',
    message: `template: ${opts.name} umbenannt (neue Datei angelegt)`,
  })
  return provider.deleteFile(repoRef, templatePath(oldIdPart), {
    branch: 'main',
    message: `template: ${opts.name} umbenannt (alte Datei entfernt)`,
    sha: opts.oldSha,
  })
}

/** Löscht eine Space-Vorlage. `sha` ist der Blob-SHA des bekannten Standes
 *  (Forgejo/GitHub verlangen ihn beim Löschen, s. `GitProvider.deleteFile`). */
export async function deleteTemplate(
  provider: GitProvider,
  repoRef: RepoRef,
  idPart: string,
  opts: { sha: string; message: string },
): Promise<{ commitSha: string }> {
  return provider.deleteFile(repoRef, templatePath(idPart), {
    branch: 'main',
    message: opts.message,
    sha: opts.sha,
  })
}

/** Baut aus der globalen Templates-Konfiguration ein `SpaceConfig`-kompatibles
 *  Objekt, ausschließlich um `TemplatesDeps.providerRegistry` (die Provider-
 *  Instanz nach `space.provider` wählt) auch für das globale Repo aufrufen zu
 *  können — kein echter Space, nie an anderer Stelle sichtbar. */
function globalPseudoSpace(cfg: GlobalTemplatesConfig): SpaceConfig {
  return {
    id: '__global-templates__',
    name: 'Globale Vorlagen',
    provider: cfg.provider,
    owner: cfg.owner,
    repo: cfg.repo,
    defaultLang: 'de',
    repoRef: cfg.repoRef,
  }
}

async function listSourceTemplates(
  provider: GitProvider,
  repoRef: RepoRef,
  source: 'space' | 'global',
): Promise<TemplateSummary[]> {
  const tree = await provider.listTree(repoRef, 'main')
  const files = tree.filter(isTemplateFile)

  const summaries: TemplateSummary[] = []
  for (const file of files) {
    const idPart = fileNameToIdPart(file.path)
    const { content } = await provider.readFile(repoRef, file.path, 'main')
    const { frontmatter } = parsePage(content)
    summaries.push({
      id: `${source}:${idPart}`,
      name: frontmatter.title ?? idPart,
      description: frontmatter.description ?? '',
      source,
    })
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name, 'de'))
  return summaries
}

/**
 * Listet `_templates/*.md` aus dem Space-Repo und (falls konfiguriert) dem
 * globalen Templates-Repo (Entscheidung 5 der Spec §6). Ist eine Quelle nicht
 * erreichbar (Provider-Fehler), wird NUR diese Quelle übersprungen (warn-Log)
 * — Lesen darf nie ganz ausfallen (projektweiter Grundsatz, siehe
 * `routes/graph.ts#workflowSets`). Sortierung: Space-Templates vor globalen,
 * innerhalb einer Quelle nach `name` (`localeCompare('de')`).
 */
export async function listTemplates(
  deps: TemplatesDeps,
  space: SpaceConfig,
  log: { warn: (o: unknown, m: string) => void },
): Promise<TemplateSummary[]> {
  const result: TemplateSummary[] = []

  try {
    const provider = deps.providerRegistry(space)
    result.push(...(await listSourceTemplates(provider, space.repoRef, 'space')))
  } catch (err) {
    log.warn(
      { err, space: space.id, source: 'space' },
      'Templates: Space-Quelle nicht erreichbar — übersprungen',
    )
  }

  if (deps.globalTemplates) {
    try {
      const provider = deps.providerRegistry(globalPseudoSpace(deps.globalTemplates))
      result.push(...(await listSourceTemplates(provider, deps.globalTemplates.repoRef, 'global')))
    } catch (err) {
      log.warn(
        { err, space: space.id, source: 'global' },
        'Templates: globale Quelle nicht erreichbar — übersprungen',
      )
    }
  }

  return result
}

/**
 * Liest ein einzelnes Template per Id (`<source>:<dateiname-ohne-md>`).
 * `null` bei jeder Art von unbekannter/ungültiger Anfrage — unbekannte Id,
 * unbekannte Quelle, nicht konfiguriertes globales Repo, Pfad-Traversal-
 * Versuch oder eine (echte) 404 vom Provider. `body` ist der Markdown-Inhalt
 * OHNE Frontmatter-Block (`splitFrontmatter`), mit `trimStart()` auf die
 * dadurch freigelegte(n) führende(n) Leerzeile(n). `description` (Vorlagen-
 * Pflege, PATCH-Bearbeiten-UI) ist der rohe Frontmatter-Wert, `''` wenn keine
 * gesetzt ist — zusammen mit `name`/`body` liefert das der UI alle drei
 * Felder EINZELN (statt einem rohen Frontmatter-Block), damit sie ein
 * Bearbeiten-Formular ohne eigenes YAML-Parsing befüllen kann.
 */
export async function readTemplateBody(
  deps: TemplatesDeps,
  space: SpaceConfig,
  templateId: string,
): Promise<{ name: string; description: string; body: string } | null> {
  const parsed = parseTemplateId(templateId)
  if (!parsed) return null
  const { source, idPart } = parsed

  let repoRef: RepoRef
  let providerSpace: SpaceConfig
  if (source === 'space') {
    repoRef = space.repoRef
    providerSpace = space
  } else if (deps.globalTemplates) {
    repoRef = deps.globalTemplates.repoRef
    providerSpace = globalPseudoSpace(deps.globalTemplates)
  } else {
    return null
  }

  const provider = deps.providerRegistry(providerSpace)

  try {
    const file = await provider.readFile(repoRef, templatePath(idPart), 'main')
    const { frontmatter } = parsePage(file.content)
    const { body } = splitFrontmatter(file.content)
    return {
      name: frontmatter.title ?? idPart,
      description: frontmatter.description ?? '',
      body: body.trimStart(),
    }
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}
