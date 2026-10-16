FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# esbuild bundles src/server.ts with the LibreOffice runner from @f451/import
# into one self-contained dist/server.mjs (see apps/convert/build.mjs).
RUN pnpm --filter @f451/convert exec node build.mjs

FROM alpine:3.22
RUN apk add --no-cache \
      nodejs \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      font-dejavu font-liberation font-noto \
 && addgroup -S convert \
 && adduser -S -G convert -H -h /work convert
WORKDIR /app
COPY --from=build /repo/apps/convert/dist ./dist
# Each job writes its own LibreOffice profile (macros disabled) and all temporary
# files into a sub-directory of CONVERT_WORK_DIR — a tmpfs in the compose stack,
# the root filesystem is read-only.
ENV NODE_ENV=production \
    PORT=8080 \
    CONVERT_WORK_DIR=/work
EXPOSE 8080
USER convert
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/server.mjs"]
