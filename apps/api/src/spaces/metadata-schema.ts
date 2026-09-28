import type { GitProvider } from '@f451/git-provider'
import { NotFoundError } from '@f451/git-provider'
import { EMPTY_METADATA_SCHEMA, parseMetadataSchema, type MetadataSchema } from '@f451/markdown'
import type { SpaceConfig } from './config.js'

/** Pfad der Metadaten-Schema-Datei im Space-Repo — neben `_media/`/`_templates/`
 *  (Feature M1, Nutzer-Entscheidung: Schema als git-versionierte Repo-Datei). */
export const METADATA_SCHEMA_PATH = '_meta/schema.yaml'

export interface MetadataSchemaDeps {
  providerRegistry: (space: SpaceConfig) => GitProvider
  /** Injectbare Uhr (Default: Date.now) — für deterministische TTL-Tests
   *  (Muster `auth/permissions.ts`). */
  now?: () => number
}

/** Minimal-Logger-Vertrag (Fastifys `app.log`/`req.log` erfüllen ihn), damit
 *  Aufrufer ohne Logger (Tests) trotzdem einen übergeben können. */
export interface MetadataSchemaLogger {
  warn: (obj: unknown, msg: string) => void
}

interface CacheEntry {
  schema: MetadataSchema
  expiresAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000

// Modul-globaler Cache (Muster `auth/permissions.ts`): in Produktion existiert
// genau eine App-Instanz, ein Modul-Singleton passt. Schlüssel ist das Tupel
// (Space-Id, Ref) als JSON — ein Schema kann sich zwischen `main` und einem
// Draft-Branch unterscheiden (z. B. eine Schema-Änderung im selben Draft-PR).
const cache = new Map<string, CacheEntry>()

function cacheKey(spaceId: string, ref: string): string {
  return JSON.stringify([spaceId, ref])
}

/**
 * Lädt und parst `_meta/schema.yaml` aus dem Space-Repo über den vorhandenen
 * GitProvider (Muster `templates/registry.ts#listSourceTemplates`: `readFile`
 * + Parsen). Fail-Soft in JEDEM Fehlerfall (Philosophie wie
 * `parseFrontmatterBlock`/`parseMetadataSchema`: nie werfen):
 *
 *  - Datei existiert nicht (`NotFoundError`) → leeres Schema, KEIN Log (kein
 *    Schema zu konfigurieren ist der Normalfall, kein Fehler).
 *  - Datei nicht lesbar (anderer Provider-Fehler, z. B. Ausfall) → leeres
 *    Schema, mit Warn-Log (Lesen darf nie ausfallen, Spec §9 — die Rail/Route
 *    bekommt trotzdem eine Antwort).
 *  - Datei vorhanden, aber YAML/Felder ungültig → `parseMetadataSchema`
 *    liefert bereits fail-soft ein (ggf. teilweise leeres) Schema; Fehler
 *    werden geloggt, nicht geworfen.
 *
 * Ergebnis wird 5 min pro (Space, Ref) gecacht (Muster `auth/permissions.ts`),
 * damit nicht jede Anfrage (Schema-Route, künftig Editor-Rail) den Provider
 * trifft.
 */
export async function loadMetadataSchema(
  deps: MetadataSchemaDeps,
  space: SpaceConfig,
  ref: string,
  log: MetadataSchemaLogger,
): Promise<MetadataSchema> {
  const now = deps.now ?? Date.now
  const key = cacheKey(space.id, ref)

  const cached = cache.get(key)
  if (cached && cached.expiresAt > now()) return cached.schema

  let schema: MetadataSchema = EMPTY_METADATA_SCHEMA
  try {
    const provider = deps.providerRegistry(space)
    const file = await provider.readFile(space.repoRef, METADATA_SCHEMA_PATH, ref)
    const parsed = parseMetadataSchema(file.content)
    if (parsed.errors.length > 0) {
      log.warn(
        { space: space.id, ref, errors: parsed.errors },
        'Metadaten-Schema: ungültige Felder übersprungen (fail-soft)',
      )
    }
    schema = parsed.schema
  } catch (err) {
    if (!(err instanceof NotFoundError)) {
      log.warn(
        { err, space: space.id, ref },
        'Metadaten-Schema: Datei nicht lesbar — leeres Schema (fail-soft)',
      )
    }
    schema = EMPTY_METADATA_SCHEMA
  }

  cache.set(key, { schema, expiresAt: now() + CACHE_TTL_MS })
  return schema
}

/** Leert den Cache. Primär für Tests (Isolation zwischen Fällen), analog zu
 *  `auth/permissions.ts#clearPermissionCache`. */
export function clearMetadataSchemaCache(): void {
  cache.clear()
}
