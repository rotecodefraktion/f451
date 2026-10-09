import { sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { SpaceAccess } from '../auth/permissions.js'
import type { Db } from '../db/client.js'
import type { SpaceConfig } from '../spaces/config.js'
import type { GitProvider } from '@f451/git-provider'
import { CLASSIFICATIONS, compareClassifications, type Classification } from '@f451/markdown'
import { loadMetadataSchema } from '../spaces/metadata-schema.js'

export interface SearchDeps {
  db: Db
  /** Konfigurierte Spaces — nur nötig, wenn `access` gesetzt ist (Filterung). */
  spaces?: readonly SpaceConfig[]
  /**
   * Zugriffsprüfer (Plan Task 5). Ist er gesetzt, liefert die Suche nur Treffer
   * aus Spaces, die der Nutzer lesen darf. Ohne ihn (kein Auth) bleibt alles
   * sichtbar (1c-Verhalten).
   */
  access?: SpaceAccess
  /**
   * Schreibrechte-Probe (Fix Review-Befund 2, Task 2a-3): der Plan verlangt
   * für die Draft-Suche (`ref=draft`) verbatim „alle Drafts für alle
   * Schreibberechtigten des Space" — nicht Leseberechtigte. Nur für
   * `ref=draft` genutzt; die main-Suche bleibt unverändert bei `access.canRead`.
   * Ohne `access` (kein Auth) greift auch hier nichts (1c-Verhalten).
   */
  canWrite?: (userId: string, space: SpaceConfig) => Promise<boolean>
  /** Task 2 (Rate-Limits, Spec §7): Anfragebudget für `GET /api/search`
   *  (`deps.rateLimits.search` aus `app.ts`, Default oder `AppOptions.rateLimits`). */
  rateLimit: { max: number; windowMs: number }
  /** Service-account provider to read each space's `_meta/schema.yaml`
   *  (security classifications, #39). Without it no space has classes. */
  providerRegistry?: (space: SpaceConfig) => GitProvider
}

interface SearchRow {
  id: string
  title: string
  space: string
  path: string
  rank: number
  snippet: string
  classification: Classification | null
  [key: string]: unknown
}

/**
 * SQL for the effective class of a hit: page value, else the default of its
 * space; `null` in spaces without classes. Built from the schemas of the
 * spaces in scope, so the filter runs before ORDER BY/LIMIT and a hidden page
 * never takes a slot in the 25-hit window.
 */
async function classificationExpression(
  deps: SearchDeps,
  spaceIds: readonly string[],
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<SQL> {
  const registry = deps.providerRegistry
  if (!registry) return sql`null::text`
  const spaces = (deps.spaces ?? []).filter((s) => spaceIds.includes(s.id))
  const schemas = await Promise.all(
    spaces.map((space) => loadMetadataSchema({ providerRegistry: registry }, space, 'main', log)),
  )
  const branches = spaces.flatMap((space, i) => {
    const settings = schemas[i]!.classification
    return settings
      ? [sql`when ${space.id} then coalesce(p.frontmatter->>'classification', ${settings.default})`]
      : []
  })
  if (branches.length === 0) return sql`null::text`
  return sql`(case p.space_id ${sql.join(branches, sql` `)} else null end)`
}

/** Task 2 (Rate-Limits, Spec §7): projektweites {status,reason}-Format
 *  (Muster `routes/drafts.ts`/`routes/templates.ts`) für den 429-Zweig, den
 *  @fastify/rate-limit über `error-format.ts` wirft. */
const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const searchSchema = {
  tags: ['search'],
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string' },
      space: { type: 'string' },
      tag: { type: 'string' },
      // Phase 2a Task 3: 'draft' liefert Treffer aus dem Draft-Index (ref='draft',
      // für Autoren such- und auffindbar). Default bleibt 'main' — unverändertes
      // 1c/1d-Verhalten, wenn der Parameter fehlt.
      ref: { type: 'string', enum: ['main', 'draft'] },
      // Phase 3a: Tipp-Suche — das letzte Wort der Anfrage matcht als
      // Wortanfang (tsquery `:*`) gegen den ungestemmten simple-Anteil des
      // Vektors. Opt-in, Default false (Bestandsverhalten unverändert).
      prefix: { type: 'boolean' },
    },
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          space: { type: 'string' },
          // Phase 2c: der `index.md`-Pfad der Seite — das `[[`-Autocomplete im
          // Editor braucht ihn als eindeutiges Wikilink-Target
          // (`LinkResolver.#resolveWikilink` matcht `<ziel>/index.md`).
          path: { type: 'string' },
          snippet: { type: 'string' },
          classification: { type: 'string' },
          rank: { type: 'number' },
        },
        required: ['id', 'title', 'space', 'path', 'snippet', 'rank'],
      },
    },
    429: errorSchema,
  },
} as const

/**
 * Baut die tsquery für `q`. Immer OR-verknüpft über drei Konfigurationen
 * (`german`/`english`/`simple`): die Sprache der Anfrage ist unbekannt, der
 * `search_vector` ist je nach Seiten-`lang` german- ODER english-gestemmt
 * (Indexer `tsConfig`), plus simple-Anteil (Gewicht C). Bisher fehlte der
 * english-Zweig — englischsprachige Seiten waren nur über exakte Wortformen
 * (simple) findbar.
 *
 * Mit `prefix` kommt ein vierter Zweig für die Tipp-Suche dazu: das letzte
 * Wort matcht als Präfix (`wort:*`, `to_tsquery('simple', …)`) — `[[Deplo`
 * findet so bereits „Deployment". Die Tokens werden dafür auf Buchstaben/
 * Ziffern reduziert (`\p{L}\p{N}`): tsquery-Syntaxzeichen (`& | ! ( ) : *`)
 * sind hier Nutzereingabe, keine Operatoren. Bleibt nach der Bereinigung
 * nichts übrig, entfällt der Präfix-Zweig ersatzlos — `to_tsquery('')` wäre
 * ein Postgres-Syntaxfehler.
 */
function buildTsquery(q: string, prefix: boolean): SQL {
  const stemmed = sql`websearch_to_tsquery('german', ${q}) || websearch_to_tsquery('english', ${q}) || websearch_to_tsquery('simple', ${q})`
  if (!prefix) return sql`(${stemmed})`

  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return sql`(${stemmed})`

  const expr = tokens.map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t)).join(' & ')
  return sql`(${stemmed} || to_tsquery('simple', ${expr}))`
}

/**
 * Registriert `GET /api/search?q=&space=&tag=&prefix=` (Plan Task 6). Sprache der
 * Anfrage ist unbekannt, daher Ranking über die OR-Verknüpfung dreier Textsuch-
 * Konfigurationen (`german`/`english`/`simple`, siehe `buildTsquery`) gegen den beim
 * Indexieren gesetzten `search_vector` (Plan Global Constraints). Default
 * `ref='main'`; `ref=draft` (Plan Task 3) liefert Treffer aus dem Draft-Index — verbatim
 * Plan-Vorgabe: „alle Drafts für alle Schreibberechtigten des Space" (Fix Review-Befund 2,
 * Task 2a-3). Die Draft-Suche filtert die zugänglichen Spaces daher über `canWrite`
 * statt `canRead`; die main-Suche bleibt unverändert bei `canRead` (1c/1d-Verhalten).
 * `prefix=true` (Phase 3a Task 1, opt-in) ergänzt einen Präfix-Zweig fürs letzte Wort
 * (Tipp-Suche, `buildTsquery`).
 * SQL ist strikt parametrisiert: `q`/`space`/`tag`/`ref`/`prefix` fließen ausschließlich
 * über Drizzles `sql`-Template-Platzhalter ein, nie als String-Interpolation.
 */
export function registerSearchRoutes(app: FastifyInstance, deps: SearchDeps): void {
  // Wie `registerPagesRoutes`/`registerWebhookRoutes`: eigenes (asynchron
  // bootendes) Sub-Plugin, damit die Route in der generierten OpenAPI-Spec
  // erscheint (siehe Kommentar in `pages.ts`).
  app.register(async (instance) => {
    instance.get<{
      Querystring: { q?: string; space?: string; tag?: string; ref?: 'main' | 'draft'; prefix?: boolean }
    }>(
      '/api/search',
      {
        schema: searchSchema,
        config: {
          rateLimit: {
            max: deps.rateLimit.max,
            timeWindow: deps.rateLimit.windowMs,
            // Issue #73: Agenten (API-Token) zählen pro Nutzer — sonst teilen
            // sich alle, die über den MCP-Dienst oder einen Proxy kommen, einen
            // Topf. Browser-Nutzer bleiben bei der IP.
            keyGenerator: (req) => (req.apiTokenScope && req.user ? `user:${req.user.id}` : req.ip),
          },
        },
      },
      async (req) => {
        const q = req.query.q?.trim()
        if (!q) return []

        // Default 'main' (unverändertes 1c/1d-Verhalten) — 'draft' liefert Treffer aus
        // dem Draft-Index (Plan Task 3), vollständig parametrisiert wie q/space/tag.
        const ref = req.query.ref ?? 'main'

        // Zugängliche Spaces vorab bestimmen (Proben parallel, gecacht) und als
        // WHERE-Bedingung in die Suchanfrage aufnehmen — VOR ORDER BY/LIMIT, damit
        // ranghohe Treffer aus unzugänglichen Spaces keine berechtigten Treffer aus
        // dem 25er-Ergebnisfenster verdrängen können. Leere Liste → sofort [], ohne
        // Query (keine zugänglichen Spaces, also kann nichts gefunden werden).
        //
        // ref='draft' prüft `canWrite` statt `canRead` (Fix Review-Befund 2): die
        // Draft-API ist durchgehend nur für Schreibberechtigte da (siehe drafts.ts),
        // die Suche war die einzige Ausnahme. Ohne `canWrite`-Dependency (Wiring-
        // Lücke) fail-closed: kein Space gilt als zugänglich, statt fälschlich alles
        // über `canRead` durchzulassen.
        let allowedSpaceIds: string[] | null = null
        if (deps.access) {
          const spaces = deps.spaces ?? []
          const userId = req.user!.id
          const checkAccess =
            ref === 'draft'
              ? (s: SpaceConfig) => (deps.canWrite ? deps.canWrite(userId, s) : Promise.resolve(false))
              : (s: SpaceConfig) => deps.access!.canRead(userId, s)
          const allowed = await Promise.all(spaces.map(checkAccess))
          allowedSpaceIds = spaces.filter((_, i) => allowed[i]).map((s) => s.id)
          if (allowedSpaceIds.length === 0) return []
        }

        const tsquery = buildTsquery(q, req.query.prefix === true)

        const conditions: SQL[] = [sql`p.ref = ${ref}`, sql`p.search_vector @@ ${tsquery}`]
        // Drizzles `sql`-Tag expandiert ein interpoliertes Array automatisch zu
        // einer parametrisierten, klammerten Liste (`($1, $2, ...)`) — passend
        // für `IN`, nicht für `ANY` (das eine echte Postgres-Array-Literal oder
        // Subquery erwartet). Bleibt trotzdem vollständig parametrisiert.
        if (allowedSpaceIds) conditions.push(sql`p.space_id in ${allowedSpaceIds}`)
        if (req.query.space) conditions.push(sql`p.space_id = ${req.query.space}`)
        if (req.query.tag) {
          conditions.push(sql`exists (select 1 from tags t where t.page_id = p.id and t.tag = ${req.query.tag})`)
        }
        // Security classifications (#39): strictly confidential pages never
        // appear in search; confidential ones appear without a snippet.
        const scopeIds = allowedSpaceIds ?? (deps.spaces ?? []).map((sp) => sp.id)
        const cls = await classificationExpression(deps, scopeIds, req.log)
        conditions.push(sql`${cls} is distinct from 'strictly-confidential'`)
        // API tokens (#39, security finding F-03): pages above the token limit
        // are excluded here, not merely marked afterwards — the match and the
        // rank depend on the content, so a visible hit would let a token test
        // content claims word by word. `null` = space without classes (open).
        // A value outside the known classes is excluded (fail closed).
        const limit = req.apiTokenMaxClassification
        if (limit) {
          const allowedClasses = CLASSIFICATIONS.filter((c) => compareClassifications(c, limit) <= 0)
          conditions.push(sql`(${cls} is null or ${cls} in ${allowedClasses})`)
        }
        const where = sql.join(conditions, sql` and `)

        const result = await deps.db.execute<SearchRow>(sql`
          select
            p.id as id,
            p.title as title,
            p.space_id as space,
            p.path as path,
            ts_rank(p.search_vector, ${tsquery}) as rank,
            ts_headline('simple', p.plain_text, ${tsquery}) as snippet,
            ${cls} as classification
          from pages p
          where ${where}
          order by rank desc
          limit 25
        `)

        return result.rows.map((r) => {
          const hideSnippet =
            r.classification !== null && compareClassifications(r.classification, 'confidential') >= 0
          return {
            id: r.id,
            title: r.title,
            space: r.space,
            path: r.path,
            snippet: hideSnippet ? '' : r.snippet,
            rank: Number(r.rank),
            ...(r.classification ? { classification: r.classification } : {}),
          }
        })
      },
    )
  })
}
