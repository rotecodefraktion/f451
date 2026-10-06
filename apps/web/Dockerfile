FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ARG API_URL=http://localhost:3001
ENV API_URL=$API_URL
# Interner draw.io-Container fürs `/drawio`-Rewrite (next.config.ts). Wie
# API_URL zur Build-Zeit in die Rewrite-Regeln gebacken.
ARG DRAWIO_INTERNAL_URL=http://drawio:8080
ENV DRAWIO_INTERNAL_URL=$DRAWIO_INTERNAL_URL
# Interner MCP-Container fürs `/mcp`-Rewrite (next.config.ts) — der Dienst, über
# den KI-Agenten auf das Wiki zugreifen. Wie API_URL zur Build-Zeit gebacken.
ARG MCP_INTERNAL_URL=http://mcp:3002
ENV MCP_INTERNAL_URL=$MCP_INTERNAL_URL
# Leer per Default → `drawioBaseUrl()` nutzt den relativen Proxy-Pfad `/drawio`
# (same-origin, kein Rebuild pro Host/IP). Nur setzen, um den Proxy zu umgehen
# und den Editor gegen eine ABSOLUTE draw.io-Origin (z. B. embed.diagrams.net)
# laufen zu lassen.
ARG NEXT_PUBLIC_DRAWIO_URL=
ENV NEXT_PUBLIC_DRAWIO_URL=$NEXT_PUBLIC_DRAWIO_URL
RUN pnpm --filter @f451/web build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# Release version shown in the attribution notice (components/attribution.tsx),
# read at runtime. Declared in this stage, not the build stage: ARG/ENV do not
# cross stages, and a new version then does not invalidate the build cache.
ARG F451_VERSION=dev
ENV F451_VERSION=$F451_VERSION
EXPOSE 3000
USER node
CMD ["node", "apps/web/server.js"]
