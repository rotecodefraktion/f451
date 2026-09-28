import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { schema } from './schema.js'

export type Db = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Db
  /** Führt alle Migrationen aus apps/api/drizzle gegen die Zieldatenbank aus. */
  migrate(): Promise<void>
  close(): Promise<void>
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
)

export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString })
  const db = drizzle(pool, { schema })

  return {
    db,
    async migrate() {
      await migrate(db, { migrationsFolder })
    },
    async close() {
      await pool.end()
    },
  }
}
