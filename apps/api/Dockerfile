FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @f451/api build
# Die Workspace-Pakete (@f451/*) werden als TypeScript-Quelle konsumiert (kein
# eigener Build) — `node dist/server.js` scheiterte daran
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). esbuild bündelt server.ts inkl.
# der @f451/*-Pakete zu einem lauffähigen dist/server.mjs (s. apps/api/build.mjs).
RUN pnpm --filter @f451/api exec node build.mjs
# pnpm deploy erzeugt produktive node_modules ohne Workspace-Devdeps in /out.
# @f451/api/package.json hat kein "files"-Feld, daher packt "pnpm deploy" auch
# src/, test/, tsconfig.json etc. nach /out mit ein (npm-Pack-Default-Verhalten).
# Fallback: aus /out nur node_modules + package.json uebernehmen, dist kommt
# direkt aus dem Build-Stage (apps/api/dist) - so landet kein Quellcode im Image.
RUN pnpm --filter @f451/api --prod deploy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
# Task 5 (Betrieb): `dist/db/migrate-cli.js` (bzw. `db/client.ts#migrationsFolder`)
# löst die Migrations-SQL-Dateien relativ zum kompilierten Modul auf
# (`../../drizzle` von `dist/db/` aus, also `/app/drizzle`) — ohne diese Zeile
# fehlte der Ordner im fertigen Image, und `node dist/db/migrate-cli.js` würde
# im Container mit ENOENT abbrechen (Regression, gefunden beim Verifizieren der
# Restore-Prozedur in `deploy/BETRIEB.md`).
COPY --from=build /repo/apps/api/drizzle ./drizzle
ENV NODE_ENV=production
EXPOSE 3001
USER node
CMD ["node", "dist/server.mjs"]
