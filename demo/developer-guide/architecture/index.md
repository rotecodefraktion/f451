---
id: architecture
title: Architecture
description: The three applications and four packages, and how a request travels through them.
tags: [architecture, overview]
lang: en
---

# Architecture

f451 is a pnpm monorepo on Node 22. Three applications and four shared
packages divide the work cleanly along one line: **`apps/api` is the only
place that checks permissions, runs the review workflow and writes to the
index.** Everything else either renders what the API gives it, or talks to
the API on someone's behalf.

## Request flow

```
Browser ──► apps/web (Next.js)  ──► apps/api (Fastify) ──► Forgejo / GitHub
                                          │                 (content, permissions)
                                          └──► PostgreSQL   (index, sessions)

AI agent ──► apps/mcp (MCP↔HTTP) ──────────► apps/api (same HTTP API)
```

Nothing skips `apps/api`. The web app never talks to Git directly, and the
MCP service never talks to Postgres or Git directly — both reach content
and permissions exclusively through the API's HTTP surface.

## The three applications

| App | Role |
|---|---|
| `apps/api` (Fastify) | Indexing, read and write endpoints, webhooks, drift reconciliation, admin. The only place with permission checks, the review workflow and the index. |
| `apps/web` (Next.js App Router) | The user interface. Proxies `/api`, `/auth`, `/admin`, `/media` to the API, `/drawio` to the draw.io container, `/mcp` to the MCP service. Server Components by default; client islands stay small. |
| `apps/mcp` | Access for AI agents: a stateless translator between MCP and the HTTP API. It wraps only the HTTP API, holds no secret of its own, and passes the calling user's token through on every request. |

## The four packages

| Package | Role |
|---|---|
| `packages/markdown` | Renders Markdown to sanitized HTML. Shared by reading and writing so both sides agree on what a construct means. |
| `packages/editor` | The ProseMirror schema behind the WYSIWYG editor. Round-trip tests with `packages/markdown` keep reading and editing aligned — a document that survives Markdown → editor → Markdown unchanged. |
| `packages/design-tokens` | The catalog of design tokens that drives the look and feel — see [[web-frontend]]. |
| `packages/git-provider` | One interface, two implementations (Forgejo, GitHub): read/write files, commits, branches, pull requests, reviews. |

See [[principles]] for why the lines are drawn exactly here, and
[[repository-layout]] for the directories underneath each of these.
