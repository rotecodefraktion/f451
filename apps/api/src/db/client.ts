import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { attachPoolErrorHandler, type PoolErrorLogger, type PoolErrorSource } from './pool-errors.js'
import { schema } from './schema.js'

export type Db = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Db
  /** The underlying pool, exposed read-only so tests can verify the error listener. */
  readonly pool: PoolErrorSource
  /** Führt alle Migrationen aus apps/api/drizzle gegen die Zieldatenbank aus. */
  migrate(): Promise<void>
  close(): Promise<void>
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
)

export function createDb(connectionString: string, log?: PoolErrorLogger): DbHandle {
  const pool = new pg.Pool({ connectionString })
  // Every pool needs an 'error' listener, not just the app's (app.ts): when
  // Postgres terminates an idle connection (restart, container stop, 57P01),
  // pg-pool emits 'error' on the pool, and without a listener that becomes an
  // unhandled error — crashing the migrate CLI or failing an otherwise green
  // test run. pg-pool discards the broken connection itself, so logging is
  // enough. Same reasoning as in pool-errors.ts.
  attachPoolErrorHandler(
    pool,
    log ?? { error: (payload, message) => console.warn(message, payload.err) },
  )
  const db = drizzle(pool, { schema })

  return {
    db,
    pool,
    async migrate() {
      await migrate(db, { migrationsFolder })
    },
    async close() {
      await pool.end()
    },
  }
}
