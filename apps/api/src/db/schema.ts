import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * tsvector wird nicht als generierte Spalte geführt (Sprachwahl ist pro Zeile
 * unterschiedlich, siehe Plan Global Constraints), sondern beim Indexieren
 * explizit per SQL-Update gesetzt. Drizzle kennt tsvector nicht nativ, daher
 * customType.
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  name: text('name').notNull(),
  defaultLang: text('default_lang').notNull(),
  /** Task 5 (HEAD-Abgleich): letzter indexierte HEAD-SHA des main-Refs. */
  indexedHeadSha: text('indexed_head_sha'),
})

export const pages = pgTable(
  'pages',
  {
    // KEIN eigenständiger Primärschlüssel mehr (Phase 2a Task 3): dieselbe
    // Seiten-`id` existiert gleichzeitig als `ref='main'`- UND `ref='draft'`-
    // Zeile (Draft-Indexierung, Lese-API sieht weiterhin nur main). Der
    // Primärschlüssel ist daher das Paar `(id, ref)` — siehe zusammengesetzten
    // `primaryKey(...)` unten. `clearDraftIndex`/`upsertPage` (Task 2/1c)
    // setzen das bereits so voraus.
    id: text('id').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    frontmatter: jsonb('frontmatter').notNull().default({}),
    frontmatterErrors: jsonb('frontmatter_errors').notNull().default([]),
    headings: jsonb('headings').notNull().default([]),
    plainText: text('plain_text').notNull().default(''),
    htmlRendered: text('html_rendered').notNull().default(''),
    lang: text('lang').notNull(),
    archived: boolean('archived').notNull().default(false),
    errorStatus: text('error_status'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Autor des letzten main-Commits dieser Seite (Metadaten-Feature M3b Teil A,
     * `type: auto, source: last_author`) — NULLABLE, weil er nur bei
     * inkrementeller Indexierung (`indexer/incremental.ts`, Webhook-Push ODER
     * synchrone Neu-Indexierung nach `POST /release`) über
     * `GitProvider#listCommits` ermittelt wird, NICHT beim Voll-Reindex
     * (`indexer/index-space.ts#indexSpace`, initialer Import/Drift-Job):
     * dort bliebe ein zusätzlicher `listCommits`-Aufruf PRO Seite ein O(n)-
     * Mehraufwand bei potenziell sehr vielen Dateien in einem einzigen,
     * synchronen Lauf. Ein frisch importierter, noch nie über die App
     * bearbeiteter Space zeigt deshalb bis zur ersten inkrementellen
     * Aktualisierung KEINEN `last_author` (Rail lässt das Feld dann einfach
     * weg, s. `routes/pages.ts#applyAutoMetadata`/`spaces/metadata-auto.ts`)
     * — bewusst dokumentierter Kompromiss, kein Bug. `onConflictDoUpdate`
     * (`upsertPage`) lässt den bestehenden Wert unangetastet, wenn der
     * Aufrufer keinen neuen mitgibt (Voll-Reindex überschreibt einen bereits
     * bekannten Autor also nie mit `null`).
     */
    lastAuthor: text('last_author'),
    /**
     * Blob-SHA (Dateiinhalt, NICHT Commit-SHA) des zuletzt indexierten Standes
     * dieser Datei — geliefert vom `/contents/{path}`-Endpunkt beim Lesen
     * (`GitProvider#readFile`, s. `packages/git-provider/src/forgejo.ts`).
     *
     * WARUM Blob- statt Commit-Vergleich: Die Frage "hat sich der INHALT seit
     * der Freigabe geändert?" beantwortet ein Inhaltsvergleich (Blob gegen
     * Blob, s. `pageVersions.blobSha` unten) richtig — ein Commit-Vergleich
     * würde dagegen JEDEN Commit als Änderung werten, auch einen, der diese
     * Datei gar nicht berührt (z. B. eine andere Seite im selben Repo). Weicht
     * dieser Wert vom `blobSha` der neuesten Version ab, gab es einen Commit
     * an der Freigabe vorbei — die Leseansicht markiert das ("geändert seit
     * X"). Aus Git ableitbar, wie alles in diesem Index.
     */
    lastBlobSha: text('last_blob_sha'),
    /**
     * Geschwister-Reihenfolge (Phase 3.3, „Baum-Umsortierung über `.order`-
     * Dateien"): Position dieser Seite in der `.order`-Datei ihres
     * Elternverzeichnisses (`indexer/order-file.ts#computeOrderKeys`), 0-basiert.
     * NULLABLE — `null` heißt „kein Eintrag in der `.order`-Datei" (kein
     * `.order` vorhanden ODER Seite dort nicht gelistet); `routes/pages.ts`s
     * Baum-Sortierung behandelt `null` als NACH allen gesetzten Werten,
     * sortiert dann alphabetisch nach Titel (Fallback/Gleichstand). Der
     * Voll-Reindex (`indexer/index-space.ts#indexSpace`) berechnet den Wert bei
     * JEDEM Lauf NEU aus der `.order`-Datei (überschreibt ihn explizit, verwirft
     * ihn also NIE stillschweigend) — die inkrementelle Indexierung
     * (`indexer/incremental.ts`) lässt ihn dagegen unangetastet (analog
     * `lastAuthor` oben): ein `.order`-Datei-Commit selbst löst keinen
     * Webhook-Reindex einer `index.md` aus (`.order` ist keine Seiten-Datei,
     * `isPageFile`), die Umsortier-Route (`routes/reorder.ts`) aktualisiert
     * betroffene Zeilen deshalb direkt gezielt statt über `indexChangedFiles`.
     */
    orderKey: integer('order_key'),
    searchVector: tsvector('search_vector'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.ref] }),
    uniqueIndex('pages_space_path_ref_unique').on(table.spaceId, table.path, table.ref),
    index('pages_search_vector_gin').using('gin', table.searchVector),
  ],
)

export const edges = pgTable(
  'edges',
  {
    fromPageId: text('from_page_id').notNull(),
    // Broken Link = toPageId null + rawTarget befüllt. Wird das Zielpage
    // gelöscht, degradiert die Kante zur Broken-Link-Kante statt zu
    // verschwinden (SET NULL statt CASCADE).
    toPageId: text('to_page_id'),
    rawTarget: text('raw_target').notNull(),
    type: text('type').notNull(),
    // label ist fachlich nullable, aber Teil des PK — NOT NULL DEFAULT '' statt
    // echtem NULL, da NULL in zusammengesetzten PKs keine Eindeutigkeit erzwingt.
    label: text('label').notNull().default(''),
    // Ref-Version des Graphen, dem diese Kante angehört (Phase 2a Task 3: `pages`
    // hat seit der Draft-Indexierung keinen alleinstehenden Primärschlüssel mehr
    // auf `id`, FKs müssen daher das Paar `(id, ref)` referenzieren).
    //
    // NOT NULL DEFAULT 'main' (P1-Fix aus Phase 2a, umgesetzt Phase 2d Task 1):
    // vormals war die Spalte bewusst NULLABLE, weil Postgres bei einem
    // zusammengesetzten `ON DELETE SET NULL` auf `(toPageId, ref)` BEIDE Spalten
    // gemeinsam nullt — ein NOT NULL auf `ref` hätte diesen SET-NULL-Vorgang beim
    // Löschen der Zielseite mit einem Constraint-Fehler abbrechen lassen. Das
    // machte aber unter MATCH SIMPLE (Postgres' FK-Default) eine Lücke auf: ist
    // AUCH NUR EINE Spalte eines zusammengesetzten FK NULL, prüft Postgres den
    // gesamten FK für diese Zeile gar nicht mehr — eine Zeile mit gesetztem
    // `toPageId`, aber `ref = NULL`, konnte also unbemerkt auf eine nicht
    // existierende `(id, ref)`-Kombination in `pages` zeigen, ohne dass der FK
    // das verhindert hätte. Migration 0004 schließt die Lücke, indem `ref` NOT
    // NULL wird (Broken-Link-Zeilen behalten dadurch immer eine gültige
    // Ref-Version) UND der `(toPageId, ref)`-FK per PG15-Sondersyntax
    // `ON DELETE SET NULL (to_page_id)` spaltenselektiv gemacht wird — beim
    // Löschen der Zielseite nullt Postgres dann NUR `toPageId`, `ref` bleibt
    // stehen (Broken-Link-Mechanismus bleibt intakt, siehe Migration 0004 für
    // das rohe SQL, das Drizzle so nicht generieren kann). `replaceEdgesForPage`
    // (Indexer) schreibt `ref: 'main'` seither explizit statt sich auf den
    // Spalten-Default zu verlassen.
    ref: text('ref').notNull().default('main'),
  },
  (table) => [
    primaryKey({ columns: [table.fromPageId, table.rawTarget, table.type, table.label] }),
    foreignKey({
      columns: [table.fromPageId, table.ref],
      foreignColumns: [pages.id, pages.ref],
    }).onDelete('cascade'),
    // Drizzle kann PG15s spaltenselektives `ON DELETE SET NULL (to_page_id)`
    // nicht abbilden (ForeignKeyBuilder#onDelete nimmt nur eine flache Aktion,
    // keine Spaltenliste) — dieser Builder erzeugt daher NUR das TS-seitige
    // Vertragsbild (spaltenselektiv, nullt real nur toPageId). Die tatsächliche
    // DB-Constraint-Definition kommt aus dem rohen SQL in Migration 0004.
    foreignKey({
      columns: [table.toPageId, table.ref],
      foreignColumns: [pages.id, pages.ref],
    }).onDelete('set null'),
  ],
)

export const tags = pgTable(
  'tags',
  {
    pageId: text('page_id').notNull(),
    tag: text('tag').notNull(),
    // Siehe Kommentar bei `edges.ref` — dieselbe Notwendigkeit (FK auf das
    // zusammengesetzte `pages(id, ref)`). Tags werden aktuell nur für
    // ref='main' angelegt, daher genügt ein NOT-NULL-Default.
    ref: text('ref').notNull().default('main'),
  },
  (table) => [
    primaryKey({ columns: [table.pageId, table.tag] }),
    foreignKey({
      columns: [table.pageId, table.ref],
      foreignColumns: [pages.id, pages.ref],
    }).onDelete('cascade'),
  ],
)

/** Auth-Nutzer, identifiziert über den OIDC-`sub`-Claim (kein eigener Passwort-Bestand, Spec Abschnitt 7).
 *  Vor `locks` deklariert (statt wie zuvor danach), damit `locks.userId` unten per
 *  `() => users.id` auf eine bereits initialisierte Konstante referenziert — dieselbe
 *  Reihenfolge-Konvention wie bei `pages`→`spaces` oben (referenzierte Tabelle zuerst). */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const locks = pgTable(
  'locks',
  {
    pageId: text('page_id').primaryKey(),
    // Siehe Kommentar bei `edges.ref`. Locks sind fachlich ref-unabhängig (ein
    // Lock gilt für die Seite als Ganzes), referenzieren hier aber immer die
    // main-Zeile — die existiert stabil, solange die Seite überhaupt bekannt ist.
    ref: text('ref').notNull().default('main'),
    // Fix P1-Backlog aus Phase 2a: Besitz wird über die STABILE, eindeutige
    // `userId` verglichen (FK auf `users.id`, cascade), NICHT mehr über den
    // nicht-eindeutigen Anzeigenamen — zwei Nutzer mit demselben OIDC-`name`-
    // Claim konnten sonst gegenseitig Locks übernehmen/löschen (P1-Bug,
    // `routes/locks.ts#upsertLock`). `userName` bleibt als reines Anzeigefeld
    // erhalten (Auskunft „wer hält den Lock", nie für Besitzvergleiche genutzt).
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userName: text('user_name').notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.pageId, table.ref],
      foreignColumns: [pages.id, pages.ref],
    }).onDelete('cascade'),
  ],
)

/** Sessions sind flüchtige Betriebsdaten (Plan Global Constraints): Verlust ⇒ Nutzer loggt sich neu ein. */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Verknüpfte Git-Provider-Konten (Forgejo/GitHub); Tokens sind AES-256-GCM-verschlüsselt (nie im Klartext). */
export const providerAccounts = pgTable(
  'provider_accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerLogin: text('provider_login').notNull(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    /** Der Provider hat den Refresh abgelehnt; die Verknüpfung muss im Browser
     *  neu hergestellt werden (Issue #70). Wird bei jedem erfolgreichen
     *  Token-Tausch zurückgesetzt. */
    needsReconnect: boolean('needs_reconnect').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
)

/**
 * Persönliche API-Tokens (MCP-Phase 0, Fundament für den späteren MCP-Server):
 * ein Nutzer erzeugt sich selbst ein Bearer-Token (`f451_pat_<...>`, siehe
 * `auth/crypto.ts#generateApiToken`), das den Session-Auth-Hook (`auth/
 * sessions.ts#createSessionAuthHook`) als Fallback ohne Browser-Cookie
 * bedient — `req.user` wird darüber exakt so gesetzt wie bei einer echten
 * Session, sodass sämtliche bestehenden Schreibrouten (die nur an
 * `req.user.id` hängen, s. `resolveWriteContext`) UNVERÄNDERT bleiben.
 *
 * NUR der SHA-256-Hash des Klartext-Tokens wird gespeichert (`tokenHash`) —
 * der Klartext selbst existiert einzig im Moment der Erzeugung (Antwort von
 * `POST /api/tokens`, s. `routes/tokens.ts`) und ist danach nicht mehr
 * rekonstruierbar. `scope` ('read'|'write') steuert das Schreib-Gate in
 * `app.ts` (Nur-Lese-Tokens dürfen keine mutierenden Requests auslösen).
 * Widerruf ist ein Soft-Delete (`revokedAt`) statt eines echten Löschens —
 * Konsistenz mit dem Rest des Projekts (`archived` bei `pages`, nie stiller
 * Datenverlust).
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    // Format wie Session-Ids (`auth/crypto.ts#generateSessionId`), keine
    // eigene Id-Erzeugungsstrategie nötig.
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(),
    scope: text('scope').notNull().default('read'),
    /** Strictest page classification this token may read in full (security
     *  classifications, #39). Pages above it come back as `restricted`. */
    maxClassification: text('max_classification').notNull().default('internal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('api_tokens_token_hash_unique').on(table.tokenHash)],
)

/**
 * Zuordnung Version → Git-Stand (Seitenversionierung).
 *
 * ABLEITBARER CACHE, keine Quelle der Wahrheit: Die Versionshistorie lebt im
 * Frontmatter der Seite und damit in Git. Diese Tabelle existiert, weil der
 * `mergeSha` einer Version im Frontmatter NICHT stehen kann — er entsteht erst
 * beim Merge, also nach dem Commit, der die Version schreibt. Ein Reindex kann
 * sie vollständig aus der Commit-Historie wiederherstellen (s.
 * `deploy/BETRIEB.md`: pg-data ist reine Ableitung).
 */
export const pageVersions = pgTable(
  'page_versions',
  {
    pageId: text('page_id').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Anzeigeform, z. B. '1.2.0'. */
    version: text('version').notNull(),
    // Drei Zahlenspalten AUSSCHLIESSLICH zum Sortieren: als Text sortiert
    // '1.10.0' vor '1.2.0', wodurch die Versionsliste ab der zehnten
    // Minor-Version in falscher Reihenfolge stünde.
    major: integer('major').notNull(),
    minor: integer('minor').notNull(),
    patch: integer('patch').notNull(),
    /** Merge-Commit dieser Version — als GIT-REFERENZ zum Lesen des damaligen
     *  Standes benötigt (`readFile(repo, path, ref=mergeSha)`, Versionsdiff,
     *  spätere Etappe). Für den Inhaltsvergleich "geändert seit" ist dieser
     *  Wert NICHT geeignet (Commit-SHA ≠ Blob-SHA) — dafür siehe `blobSha`
     *  unten. Beide Spalten haben also unterschiedliche Aufgaben und sind
     *  KEIN Duplikat. */
    mergeSha: text('merge_sha').notNull(),
    /** Blob-SHA (Dateiinhalt) der Datei zum Zeitpunkt dieser Freigabe —
     *  Vergleichsgrundlage für "geändert seit" (s. `pages.lastBlobSha`
     *  Kommentar oben): ein einfacher Inhaltsvergleich, robust gegen Commits,
     *  die die Datei gar nicht berühren. Bewusst NEBEN `mergeSha` geführt,
     *  nicht als Ersatz dafür — `mergeSha` bleibt als Git-Referenz zum Lesen
     *  des damaligen Standes nötig (Versionsdiff, spätere Etappe), was ein
     *  Blob-SHA allein nicht leistet (kein `ref`, unter dem sich der
     *  historische Dateiinhalt lesen ließe). */
    blobSha: text('blob_sha').notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
    author: text('author').notNull(),
    note: text('note').notNull().default(''),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pageId, table.version] }),
  }),
)

/**
 * Frozen releases (#38): one row per `<page folder>/_releases/<version>/page.md`.
 *
 * DERIVED CACHE like `page_versions`: the copies live in Git; a reindex lists
 * the `_releases/` folders and rebuilds this table. `tampered` marks a copy
 * whose blob changed after it was frozen (a direct Git commit).
 */
export const pageReleases = pgTable(
  'page_releases',
  {
    pageId: text('page_id').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    major: integer('major').notNull(),
    minor: integer('minor').notNull(),
    patch: integer('patch').notNull(),
    /** Path of the frozen `page.md` in the repository. */
    path: text('path').notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
    author: text('author').notNull(),
    note: text('note').notNull().default(''),
    blobSha: text('blob_sha').notNull(),
    tampered: boolean('tampered').notNull().default(false),
    /** Raw `classification` of the frozen copy (null = space default). A later
     *  downgrade of the living page must not open an older, stricter copy. */
    classification: text('classification'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pageId, table.version] }),
  }),
)

export const schema = {
  spaces,
  pages,
  edges,
  tags,
  locks,
  users,
  sessions,
  providerAccounts,
  pageReleases,
  apiTokens,
  pageVersions,
}
