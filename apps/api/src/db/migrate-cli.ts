import { createDb } from './client.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL ist nicht gesetzt.')
  process.exit(1)
}

const { migrate, close } = createDb(connectionString)

try {
  await migrate()
  console.log('Migrationen erfolgreich angewendet.')
} finally {
  await close()
}
