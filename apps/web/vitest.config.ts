import { defineConfig } from 'vitest/config'

// Unit-Tests nur für serverseitige Logik in lib/ (kein React/DOM in Phase 1e Task 1).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
})
