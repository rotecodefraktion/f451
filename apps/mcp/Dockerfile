FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# esbuild bündelt src/server.ts inkl. aller Abhängigkeiten zu dist/server.mjs
# (s. apps/mcp/build.mjs) — anders als bei apps/api gibt es hier keine
# externen Ausnahmen, das Bundle ist vollständig eigenständig.
RUN pnpm --filter @f451/mcp exec node build.mjs

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/mcp/dist ./dist
ENV NODE_ENV=production
EXPOSE 3002
USER node
CMD ["node", "dist/server.mjs"]
