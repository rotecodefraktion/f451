// Produktions-Bundle des MCP-Dienstes (Muster: apps/api/build.mjs).
// Anders als die API hat der MCP keine Pakete mit Native-Bindings oder
// __dirname-relativen Assets — es kann daher alles gebündelt werden, ohne
// Ausnahmen. Das schließt die eine Workspace-Abhängigkeit ein
// (`@f451/design-tokens`, seit dem Diagramm-Generator): Das Paket exportiert
// TypeScript-Quelle, die esbuild hier mitübersetzt.
import { build } from 'esbuild'

await build({
  entryPoints: { server: 'src/server.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
  // ESM-Interop: einige eingebündelte CJS-Pakete nutzen require/__dirname.
  banner: {
    js: "import { createRequire as __cr } from 'module'; import { fileURLToPath as __fp } from 'url'; import { dirname as __dn } from 'path'; const require = __cr(import.meta.url); const __filename = __fp(import.meta.url); const __dirname = __dn(__filename);",
  },
})
