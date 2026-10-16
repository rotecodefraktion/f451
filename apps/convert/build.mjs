// Production bundle of the convert service (pattern: apps/mcp/build.mjs). The
// service imports only the LibreOffice runner from @f451/import (subpath
// `./office/soffice`), so the bundle holds that file, fflate and this server.
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
})
