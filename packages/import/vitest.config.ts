import { defineConfig } from 'vitest/config'

export default defineConfig({
  // resvg's first rasterisation (export/bookstack/media.test.ts) loads the system
  // fonts and can take several seconds on a CI runner.
  test: { environment: 'node', testTimeout: 30_000 },
})
