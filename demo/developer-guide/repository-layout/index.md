---
id: repository-layout
title: Repository layout
description: What lives where in the monorepo.
tags: [architecture, reference]
lang: en
---

# Repository layout

A pnpm workspace with three applications and four packages, plus
deployment and operational tooling around them.

## `apps/`

| Directory | Contents |
|---|---|
| `apps/api` | Fastify server: route registration in `src/app.ts`, routes under `src/routes/`, the indexer under `src/indexer/`, draft/workflow logic under `src/drafts/`, auth under `src/auth/`. See [[api]]. |
| `apps/web` | Next.js App Router UI. Proxy configuration in `next.config.ts`, styles in `app/styles/*.css`, i18n messages in `lib/i18n/messages/`. See [[web-frontend]]. |
| `apps/mcp` | The stateless MCP↔HTTP translator. Tools live under `src/tools/` (`read.ts`, `write.ts`, `attachments.ts`), diagram generation under `src/diagram/`. |

## `packages/`

| Directory | Contents |
|---|---|
| `packages/markdown` | Parsing, rendering and stringifying Markdown (`parse.ts`, `render.ts`, `stringify.ts`), plus the shared constructs: `alerts.ts` (callouts), `frontmatter.ts`, `youtube.ts`, `image-size.ts`, `slug.ts`, `diff.ts`. |
| `packages/editor` | The ProseMirror schema: `extensions.ts`, `nodes/` (`alert.ts`, `image.ts`, `wiki-link.ts`, `youtube-embed.ts`), and the two directions of conversion, `from-markdown.ts` / `to-markdown.ts`. |
| `packages/design-tokens` | `tokens.ts` (generated values) and `catalog.ts` (one entry per token: level, settings-page group, role, whether a user theme may override it). |
| `packages/git-provider` | The `GitProvider` interface (`types.ts`) and its two implementations, `forgejo.ts` and `github.ts`. |

## Everything else

| Directory | Contents |
|---|---|
| `deploy/git` | Forgejo stack — must be started before `deploy/wiki`. |
| `deploy/wiki` | The wiki stack (web, api, drawio, mcp, Postgres). |
| `docs/` | Domain vocabulary, architecture decisions, agent-facing docs, design specs. |
| `scripts/` | Local setup (`dev-local-setup.sh`), deployment E2E, CSS metrics, seed content for the local demo space. |
| `.github/workflows/ci.yml` | The CI pipeline — see [[testing-and-contributing]]. |

> [!TIP]
> When you're not sure which package owns a piece of behavior, start from
> [[architecture]]'s table of roles rather than guessing from file names —
> the boundaries are drawn by responsibility, not by technology.
