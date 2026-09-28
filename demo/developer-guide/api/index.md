---
id: api
title: The API
description: Route groups, authentication, and the review workflow's SHA contract.
tags: [api, architecture]
lang: en
---

# The API

`apps/api` is a Fastify server. It is the only part of f451 that checks
permissions, runs the review workflow and writes to the index — see
[[principles]]. Everything below is registered in `src/app.ts`.

## Route groups

| Group | Examples | Notes |
|---|---|---|
| System | `GET /healthz`, `GET /readyz` | Unauthenticated, for orchestrators. |
| Docs | `GET /api/docs`, `GET /api/openapi.json` | Swagger UI and the generated OpenAPI spec, open without a session. |
| Auth | `/auth/*` (OIDC login/callback/logout), `/auth/connect/*` (link a provider account) | Open — a login flow can't require a session to start one. |
| Session & tokens | `GET /api/me`, `/api/tokens/*` | Personal API token management for agents (see [[extending]]). |
| Read | `GET /api/spaces/:space/*` (pages, tree, search, broken links, graph, metadata schema, templates), `GET /api/pages/:id`, `GET /api/pages/:id/versions*` | Filtered by the caller's read access to the underlying repository. |
| Write / drafts | `POST /api/pages`, `.../draft`, `.../draft/media`, `.../locks`, `.../move`, `.../unarchive`, `DELETE /api/pages/:id`, `PUT /api/spaces/:space/order` | Require a linked provider account with write access; committed under the user's own token. |
| Review workflow | `/api/pages/:id/draft`, `/api/pages/:id/review`, `/api/pages/:id/review/request-changes`, `/api/pages/:id/release` (MCP tools `request_review` / `release_page`, see [[extending]]) | Turns a draft branch into a pull request, then merges it. |
| Media | `/media/*` | Binary asset delivery, gated like page reads. |
| Webhooks | `/webhooks/*` | Provider push events trigger incremental reindexing; HMAC-verified, no session. |
| Admin | `/admin/reindex`, `/admin/status`, `/admin/backfill-ids` | Bearer-token gated (`F451_ADMIN_TOKEN`), fail-closed if the token isn't configured. |

## Authentication

Two independent mechanisms protect `/api/*`, `/admin/*` and `/media/*`:

- **Session cookies**, established via OIDC login (Entra, Forgejo, or any
  other OIDC provider). This is how the browser UI authenticates.
- **Personal API tokens** (`f451_pat_…`), issued through `/api/tokens` and
  used by the MCP service and other automation. Tokens carry a scope —
  `read` or `write` — and a read-scoped token gets a `403` on anything but
  `GET`.

`/admin/*` additionally accepts a separate bearer token
(`F451_ADMIN_TOKEN`) instead of a session, so ops automation can call
`POST /admin/reindex` from a plain script.

A CSRF origin check runs on every state-changing request (`POST`, `PUT`,
`PATCH`, `DELETE`): a present-but-foreign `Origin` header is rejected. A
missing header is allowed through deliberately — that's the shape of
legitimate non-browser clients (CLI, CI, webhook senders), which
`SameSite=Lax` cookies don't protect against by themselves.

## `404` is deliberately ambiguous

Read routes never distinguish "this page doesn't exist" from "you don't
have access to it" — both are a plain `404`. See [[principles]] for why.

## The review workflow and its SHA contract

Nothing writes to the published version directly. The sequence is always:

1. **Create a draft** — a branch, from the current published state.
2. **Write** — save content to the draft branch, repeatedly.
3. **Request review** — opens a pull request.
4. **Release** — merges the pull request.
5. **Reindex** — the merge webhook (or a manual `/admin/reindex`) updates
   the Postgres index from the new Git state.

Every write to a draft names a `baseSha`: the commit SHA the writer started
from. If the draft has moved on since — someone else saved a change, or a
previous save from the same writer landed — the API responds `409` with
the *current* SHA and content instead of silently overwriting it. The
caller is expected to re-fetch, reconcile, and retry with the new
`baseSha`.

> [!IMPORTANT]
> This is the same mechanism whether the writer is a human in the browser
> editor or an AI agent calling `update_page_draft` through MCP — see
> [[extending]]. There is no privileged, SHA-check-free path for agents.
