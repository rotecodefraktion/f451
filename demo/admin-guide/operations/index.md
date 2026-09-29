---
id: operations
title: Operations
description: Health checks, the admin reindex endpoint, a troubleshooting playbook, and running two instances on one host.
tags: [admin, operations, monitoring]
lang: en
---

# Operations

## Health and readiness

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | Always `200` if the process is running — no database access. |
| `GET /readyz` | `200` if a query against Postgres succeeds, `503` otherwise. Use this for orchestration readiness probes. |
| `GET /admin/status` | Bearer-token-protected (`F451_ADMIN_TOKEN`, see [[configuration-reference]]). Returns in-memory counters (`webhookErrors`, `indexerErrors`, `driftErrors`) and a `since` timestamp. The counters reset on every process restart — treat this as "is something wrong right now", not as a historical audit log. |

## Triggering a reindex

```bash
curl -X POST https://<host>/admin/reindex \
  -H "Authorization: Bearer $F451_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

An empty body reindexes every configured space; `{"space":"<space-id>"}`
reindexes just one. The response reports success or failure per space —
`200` if at least one space succeeded, `502` only if all of them failed
(check `GET /admin/status` and the `api` logs next).

> [!NOTE]
> If OIDC sign-in is active, `/admin/*` routes need a valid session **in
> addition to** the bearer token — a plain `curl` call without a browser
> session behind it gets a reproducible `401`. Run admin calls from a
> browser context where you are already signed in (developer tools'
> network/fetch panel with the session cookie present), not from a bare
> terminal.

## Troubleshooting playbook

| Symptom | Likely cause |
|---|---|
| Every API route is reachable without signing in | `F451_OIDC_ISSUER` is unset — auth is intentionally off in that state. |
| Sign-in redirects to an error page after the identity provider | `F451_OIDC_REDIRECT_URL` (or the app registration's redirect URI) doesn't match the actual callback URL exactly. |
| Every save/publish/release fails with `403` | `F451_PUBLIC_BASE_URL` doesn't match the URL users actually browse to — the CSRF origin check rejects the mismatch. See [[configuration-reference]]. |
| A webhook call fails with `401` | `F451_WEBHOOK_SECRET_FORGEJO`/`_GITHUB` doesn't match the secret configured on the repository's webhook. |
| A page edited directly in Git takes a few minutes to show up | Expected — the drift job catches up within about 5 minutes if the webhook was missed. See [[spaces-and-git-providers]]. |
| `POST /admin/reindex` / `GET /admin/status` returns `503` | `F451_ADMIN_TOKEN` is unset — both endpoints are fail-closed without it. |
| `POST /admin/reindex` returns `401` from a plain terminal call | Missing session — see the note above. |
| The rate limits seem to apply to "everyone at once" instead of per person | `F451_TRUST_PROXY` is unset or wrong for the real proxy chain — see [[configuration-reference]]. |
| The same person appears as two different users | They signed in through two different methods (e.g. OIDC once, GitHub once) — see [[github-sign-in]]. Not a bug, a consequence of having no shared identity across methods. |
| A user reports "I don't see any spaces" | Their account is signed in but has no linked Forgejo/GitHub account yet, or that account lacks repository access — see [[sign-in-options]]. |

## Running a second instance on the same host

Both the Forgejo stack and the application stack expose their ports and
cookie naming as variables, so a second instance (for example a demo or a
staging copy) can run alongside the first without conflicting:

| Variable | What it separates |
|---|---|
| `F451_COOKIE_PREFIX` | Session cookie names — without a distinct value, two instances sharing a host would overwrite each other's cookies in the browser. |
| `F451_WEB_PORT` | Host port for the web UI. |
| `F451_DRAWIO_PORT` | Host port for the diagram editor. |
| `F451_FORGEJO_HTTP_PORT` / `F451_FORGEJO_SSH_PORT` | Host ports for the second Forgejo instance. |
| `F451_FORGEJO_ROOT_URL` | The second Forgejo instance's own public URL. |

Give the second instance's Git stack its own Compose project name
(`docker compose -p <name> ...`) so its containers and volumes don't
collide with the first instance's.
