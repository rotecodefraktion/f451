---
id: configuration-reference
title: Configuration reference
description: Every environment variable the api service reads, grouped by concern.
tags: [admin, reference, configuration]
lang: en
---

# Configuration reference

All variables below are read by the `api` service. None are required to
start f451 at all — an instance with nothing set runs in a minimal,
read-only, unauthenticated mode (`/healthz`/`/readyz` only). Each group
becomes meaningful once you set its first variable.

## Spaces and providers

See [[spaces-and-git-providers]] for the full explanation.

| Variable | Required when | Default |
|---|---|---|
| `F451_SPACES` | Any space should be visible | — (minimal mode) |
| `F451_FORGEJO_URL` | A space uses `provider: "forgejo"`, or Forgejo account linking is enabled | — |
| `F451_FORGEJO_TOKEN` | A space uses `provider: "forgejo"` | — |
| `F451_GITHUB_TOKEN` | A space uses `provider: "github"` | — |
| `F451_WEBHOOK_SECRET_FORGEJO` | Forgejo webhooks should be accepted | — |
| `F451_WEBHOOK_SECRET_GITHUB` | GitHub webhooks should be accepted | — |
| `F451_GLOBAL_TEMPLATES` | A provider-wide template repository is shared across spaces | — |

## Sign-in (OIDC)

See [[sign-in-options]], [[entra-id]], [[forgejo-identity-provider]].

| Variable | Required when | Default |
|---|---|---|
| `F451_OIDC_ISSUER` | Auth should be enabled at all — unset means the entire API is unauthenticated | — (auth off) |
| `F451_OIDC_CLIENT_ID` | `F451_OIDC_ISSUER` is set | — |
| `F451_OIDC_CLIENT_SECRET` | `F451_OIDC_ISSUER` is set | — |
| `F451_OIDC_REDIRECT_URL` | `F451_OIDC_ISSUER` is set — must equal `https://<host>/auth/callback` | — |
| `F451_OIDC_PROVIDER_NAME` | Never required | unset → plain "Sign in" button |
| `F451_TOKEN_KEY` | `F451_OIDC_ISSUER` is set — otherwise the api fails to start | — |

## Sign-in (GitHub)

See [[github-sign-in]].

| Variable | Required when | Default |
|---|---|---|
| `F451_GITHUB_LOGIN` | GitHub should appear as a sign-in method | `0` (off) |
| `F451_GITHUB_OAUTH_CLIENT_ID` | `F451_GITHUB_LOGIN=1` | — |
| `F451_GITHUB_OAUTH_CLIENT_SECRET` | `F451_GITHUB_LOGIN=1` | — |

## Account linking (reading and writing)

Independent of which method someone signed in with — see
[[sign-in-options]].

| Variable | Required when | Default |
|---|---|---|
| `F451_FORGEJO_OAUTH_CLIENT_ID` / `_SECRET` | "Connect Forgejo" should be offered (needs `F451_FORGEJO_URL` too) | — (linking off) |
| `F451_GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | "Connect GitHub" should be offered | — (linking off) |

## Cookies and running more than one instance on a host

| Variable | Required when | Default |
|---|---|---|
| `F451_COOKIE_PREFIX` | A second instance shares a host with this one — browsers do not separate cookies by port | `f451` |
| `F451_WEB_PORT` | A second instance needs a different host port for the web UI | `8080` |
| `F451_DRAWIO_PORT` | A second instance needs a different host port for the diagram editor | `8081` |
| `F451_FORGEJO_HTTP_PORT` / `F451_FORGEJO_SSH_PORT` | A second Forgejo instance shares a host | Forgejo defaults |
| `F451_FORGEJO_ROOT_URL` | A second Forgejo instance shares a host | Forgejo default |

## Local development only

> [!WARNING]
> Never set either of these in production.

| Variable | Effect |
|---|---|
| `F451_INSECURE_COOKIES=1` | Drops `secure` on session cookies (plain HTTP). |
| `F451_OIDC_ALLOW_INSECURE=1` | Allows an `http://` OIDC issuer. |

## Admin and operations

See [[operations]] and [[backup-and-restore]].

| Variable | Required when | Default |
|---|---|---|
| `F451_ADMIN_TOKEN` | `POST /admin/reindex` and `GET /admin/status` should work at all — unset means both are fail-closed | — (disabled) |
| `F451_MAX_UPLOAD_MB` | A non-default media upload limit is needed | `10` |

## Rate limits and reverse proxy

| Variable | Required when | Default |
|---|---|---|
| `F451_RATE_LIMIT_AUTH_MAX` | A non-default auth rate limit is needed (per route, per client IP) | `10`/min |
| `F451_RATE_LIMIT_SEARCH_MAX` | A non-default search rate limit is needed | `60`/min |
| `F451_RATE_LIMIT_API_TOKEN_MAX` | A non-default limit for API-token traffic (MCP agents) is needed, per user across their tokens | `300`/min |
| `F451_TRUST_PROXY` | This deployment always runs behind a reverse proxy — without it, every user shares one rate-limit bucket | — (no proxy trusted) |

> [!IMPORTANT]
> `F451_TRUST_PROXY` needs the number of trusted hops between the reverse
> proxy and the `api` service, not just "on" or "off". Setting it to `true`
> trusts the left-most `X-Forwarded-For` entry, which a client can set
> itself — that makes the rate limits trivially bypassable. Verify the
> correct hop count against your actual proxy chain before relying on the
> limits in production; see [[operations]].

## Public URL

| Variable | Required when | Default |
|---|---|---|
| `F451_PUBLIC_BASE_URL` | Production, effectively always | — (falls back to the request's `Host` header) |

`F451_PUBLIC_BASE_URL` is the exact scheme and host (no path) that users
type into their browser. It is the basis for the OAuth `redirect_uri` used
when connecting a Forgejo or GitHub account, and it is the "our own
origin" side of the CSRF origin check on every write request.

> [!WARNING]
> A wrong value here does not fail loudly at startup — it fails at the
> first save, with every mutating browser request rejected with `403`. See
> [[operations]] for this symptom in the troubleshooting table.
