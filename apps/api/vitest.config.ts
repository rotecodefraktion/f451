import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Most API tests write to real Forgejo and Postgres containers; on shared
  // CI runners a test with several commits regularly takes just over 5 s.
  test: { environment: 'node', testTimeout: 15_000 },
})
