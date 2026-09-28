import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

export interface PgTestInstance {
  connectionString: string
  stop(): Promise<void>
}

/** Startet Postgres 17 als Testcontainer für Schema-/Indexer-Tests. */
export async function startPg(): Promise<PgTestInstance> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start()

  return {
    connectionString: container.getConnectionUri(),
    async stop() {
      await container.stop()
    },
  }
}
