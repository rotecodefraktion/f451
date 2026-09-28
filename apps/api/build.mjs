// Produktions-Bundle der API. Die Workspace-Pakete (@f451/git-provider,
// @f451/markdown) werden als TypeScript-Quelle konsumiert (kein eigener
// Build-Schritt) — `node dist/server.js` würde daran scheitern
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). esbuild kompiliert und
// inlined ausschließlich die @f451/*-Pakete (+ relative Module); alle
// echten npm-Abhängigkeiten (fastify, drizzle, remark, …) bleiben extern
// und werden zur Laufzeit aus node_modules geladen.
import { build } from 'esbuild'

// Alles einbündeln (@f451/*, remark/rehype, yaml, fastify, drizzle, …), damit
// keine Laufzeit-Auflösung transitiver Deps aus node_modules nötig ist. Nur
// echte Native-/dynamisch-ladende Pakete bleiben extern und werden aus
// node_modules geladen. `pg` nutzt optionale Native-Bindings + dynamische
// requires und wird nicht sauber gebündelt → extern.
// pg: optionale Native-Bindings + dynamische requires.
// @fastify/swagger-ui + @scalar: laden Static-Assets über __dirname (bündeln
// bricht die Pfadauflösung) → extern aus node_modules laden.
const EXTERNAL = [
  'pg', 'pg-native', 'pg-cloudflare',
  '@fastify/swagger', '@fastify/swagger-ui', '@scalar/fastify-api-reference',
]

await build({
  entryPoints: { server: 'src/server.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  external: EXTERNAL,
  logLevel: 'info',
  // ESM-Interop: einige eingebündelte CJS-Pakete nutzen require/__dirname.
  banner: { js: "import { createRequire as __cr } from 'module'; import { fileURLToPath as __fp } from 'url'; import { dirname as __dn } from 'path'; const require = __cr(import.meta.url); const __filename = __fp(import.meta.url); const __dirname = __dn(__filename);" },
})
