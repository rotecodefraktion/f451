import { and, eq, lte, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { locks } from '../db/schema.js'
import { LOCK_TTL_MS } from '../drafts/lifecycle.js'
import { resolveWriteContext, type DraftsDeps } from './drafts.js'

/**
 * Soft-Lock-Routen (Plan Task 4, Spec Abschnitt 4): `PUT /api/locks/:pageId`
 * (Heartbeat, upsert userName+jetzt) und `DELETE /api/locks/:pageId` (nur
 * den eigenen Lock lösen). Locks blockieren NICHT — reiner Hinweis-Charakter;
 * die Lock-AUSKUNFT für Draft-Leser ist bereits Teil der Draft-Antwort (Task 2,
 * `drafts/lifecycle.ts#loadFreshLock`). `LOCK_TTL_MS` wird von dort
 * wiederverwendet, nicht neu definiert — EINE Quelle für die TTL-Ableitung.
 *
 * Gates (requireSession global in app.ts + Space-Zugriff + Schreibrecht):
 * dieselbe `resolveWriteContext`-Kette wie bei den Draft-Routen (Task 2/3),
 * bewusst wiederverwendet statt für Locks dupliziert.
 */

/** Identisch zu `DraftsDeps` (dieselbe Gate-Kette braucht dieselben Felder) —
 *  eigener Name hier nur für Lesbarkeit an den Aufrufstellen der Lock-Routen. */
export type LocksDeps = DraftsDeps

interface LockInfo {
  heldBy: string
  expiresAt: string
  /** Serverseitig gegen `req.user.id` berechnet (P1-Fix Phase 2a): der Client
   *  bekommt NIE fremde userIds, nur diese vorberechnete Auskunft "ist das
   *  mein Lock?". */
  mine: boolean
}

function expiresAtOf(heartbeatAt: Date): string {
  return new Date(heartbeatAt.getTime() + LOCK_TTL_MS).toISOString()
}

/**
 * Atomarer Heartbeat-Upsert — bewusst KEIN Read-Then-Write (Review-Auflage):
 * Ein einziges `INSERT ... ON CONFLICT (page_id) DO UPDATE ... WHERE ...`
 * entscheidet unter der Zeilensperre von Postgres selbst, ob der aufrufende
 * Nutzer den Lock (neu) hält. Die `setWhere`-Bedingung lässt die
 * Aktualisierung NUR zu, wenn entweder derselbe Nutzer bereits hält
 * (Heartbeat-Verlängerung) oder der bestehende Lock abgelaufen ist (>=2 min
 * seit dem letzten Heartbeat — dieselbe Grenze wie
 * `drafts/lifecycle.ts#loadFreshLock`, EINE TTL-Ableitung: `LOCK_TTL_MS`,
 * `<=`-Vergleich statt `<`). Hält ein ANDERER Nutzer einen frischen Lock,
 * greift die Bedingung nicht — Postgres behandelt das wie `DO NOTHING` für diese Zeile,
 * `.returning()` liefert dann keine Zeile. Zwei gleichzeitige Heartbeats
 * verschiedener Nutzer auf derselben Seite werden dabei von Postgres selbst
 * serialisiert (Zeilensperre während des `INSERT ... ON CONFLICT`), sodass
 * genau einer gewinnt — race-frei, ohne eigene Locking-Logik im Anwendungscode.
 *
 * Besitzvergleich läuft über `userId` (P1-Fix Phase 2a), NICHT über `userName`:
 * `userName` ist der nicht-eindeutige OIDC-`name`-Claim — zwei Konten mit
 * demselben Anzeigenamen konnten sich sonst gegenseitig Locks übernehmen
 * (siehe `db/schema.ts#locks`-Kommentar). `userName` bleibt als reines
 * Anzeigefeld erhalten (Auskunft, WER hält, nie Teil des Besitzvergleichs).
 *
 * `ref` (Phase 2d Task 5): NICHT mehr hart auf `'main'` gesetzt, sondern vom
 * Aufrufer übergeben (`ctx.row.ref` aus `resolveWriteContext`) — `locks` trägt
 * eine zusammengesetzte FK auf `pages(id, ref)` (`db/schema.ts`). Eine
 * Draft-only-Seite (noch nie released, `resolveWriteContext`s Draft-only-
 * Fallback) hat KEINE `ref='main'`-Zeile in `pages` — ein hartkodiertes
 * `ref: 'main'` hier würde die Foreign-Key-Constraint verletzen (kein
 * passendes `(pageId, 'main')` in `pages`) und den Lock-Versuch mit einem
 * DB-Fehler statt der erwarteten 200-Antwort scheitern lassen.
 */
async function upsertLock(db: Db, pageId: string, ref: string, userId: string, userName: string): Promise<LockInfo> {
  const now = new Date()
  const expiredBefore = new Date(now.getTime() - LOCK_TTL_MS)

  const [won] = await db
    .insert(locks)
    .values({ pageId, ref, userId, userName, heartbeatAt: now })
    .onConflictDoUpdate({
      target: locks.pageId,
      // `ref` MIT aktualisieren (nicht nur beim Insert gesetzt): ist die
      // Seite zwischen zwei Heartbeats released worden (main-Zeile existiert
      // jetzt zusätzlich zur inzwischen gelöschten Draft-Zeile), muss der
      // Lock der neuen `ref='main'`-FK-Referenz folgen, sonst verletzt ein
      // späteres Update die FK-Constraint auf `pages(id, ref)`.
      set: { ref, userId, userName, heartbeatAt: now },
      setWhere: or(eq(locks.userId, userId), lte(locks.heartbeatAt, expiredBefore)),
    })
    .returning()

  if (won) {
    return { heldBy: won.userName, expiresAt: expiresAtOf(won.heartbeatAt), mine: won.userId === userId }
  }

  // Bedingung griff nicht → ein anderer Nutzer hält einen frischen Lock. Der
  // Schreibversuch ist damit bereits atomar entschieden (verloren) — diese
  // Abfrage dient NUR noch der Auskunft, wer aktuell hält (kein Teil der
  // Entscheidung, daher unproblematisch, dass sie ein separates Statement ist).
  const [current] = await db.select().from(locks).where(eq(locks.pageId, pageId)).limit(1)
  if (!current) {
    // Äußerst unwahrscheinliches Zwischenrennen: der fremde Lock wurde zwischen
    // dem gescheiterten Upsert und dieser Abfrage von einem Dritten gelöscht.
    // Ein erneuter Versuch löst das auf (jetzt existiert keine konkurrierende Zeile mehr).
    return upsertLock(db, pageId, ref, userId, userName)
  }
  return { heldBy: current.userName, expiresAt: expiresAtOf(current.heartbeatAt), mine: current.userId === userId }
}

const errorSchema = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'reason'],
} as const

const forbiddenSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, action: { type: 'string' } },
  required: ['error'],
} as const

const paramsSchema = {
  type: 'object',
  properties: { pageId: { type: 'string' } },
  required: ['pageId'],
} as const

const lockInfoSchema = {
  type: 'object',
  properties: { heldBy: { type: 'string' }, expiresAt: { type: 'string' }, mine: { type: 'boolean' } },
  required: ['heldBy', 'expiresAt', 'mine'],
} as const

const putLockSchema = {
  tags: ['locks'],
  params: paramsSchema,
  response: {
    200: lockInfoSchema,
    403: forbiddenSchema,
    404: errorSchema,
  },
} as const

const deleteLockSchema = {
  tags: ['locks'],
  params: paramsSchema,
  response: {
    204: { type: 'null', description: 'Der eigene Lock wurde gelöst (oder existierte nicht).' },
    403: forbiddenSchema,
    404: errorSchema,
  },
} as const

/**
 * Registriert die Soft-Lock-API (Plan Task 4). Eigenes (asynchron bootendes)
 * Sub-Plugin, damit die Routen in der von `@fastify/swagger` generierten
 * OpenAPI-Spec erscheinen (siehe Kommentar in `pages.ts`/`drafts.ts`).
 */
export function registerLocksRoutes(app: FastifyInstance, deps: LocksDeps): void {
  app.register(async (instance) => {
    // PUT: Heartbeat — legt den Lock an, verlängert den eigenen oder
    // übernimmt einen abgelaufenen fremden. Liefert IMMER 200 mit dem
    // aktuellen Halter (Hinweis-Charakter, kein Blocken laut Spec).
    instance.put<{ Params: { pageId: string } }>(
      '/api/locks/:pageId',
      { schema: putLockSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.pageId)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        return upsertLock(deps.db, req.params.pageId, ctx.row.ref, req.user!.id, req.user!.displayName)
      },
    )

    // DELETE: löst NUR den eigenen Lock (WHERE-Scope auf userId, P1-Fix — NICHT
    // mehr auf den nicht-eindeutigen userName) — ein fremder oder nicht (mehr)
    // existierender Lock bleibt unberührt, aber ohne Fehler (idempotent, analog
    // `destroySession`/`discardDraft`s `clearLock`).
    instance.delete<{ Params: { pageId: string } }>(
      '/api/locks/:pageId',
      { schema: deleteLockSchema },
      async (req, reply) => {
        const ctx = await resolveWriteContext(deps, req.user!.id, req.params.pageId)
        if (!ctx.ok) return reply.code(ctx.status).send(ctx.body)

        await deps.db
          .delete(locks)
          .where(and(eq(locks.pageId, req.params.pageId), eq(locks.userId, req.user!.id)))
        return reply.code(204).send()
      },
    )
  })
}
