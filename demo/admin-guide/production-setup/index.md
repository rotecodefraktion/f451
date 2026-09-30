---
id: production-setup
title: Production setup
description: What a production f451 server looks like — components, sizing, TLS, sign-in, images, backups, updates and monitoring.
tags: [admin, production, deployment]
lang: en
---

# Production setup

The Developer Guide describes a laptop setup: HTTP, a local Forgejo acting as
identity provider, images built from source. A production server differs in
five ways — **HTTPS everywhere**, **a real identity provider**, **released
images instead of local builds**, **a backup of the Git data** and **nothing
reachable from outside except the reverse proxy**. This page describes that
target picture; [[configuration-reference]] lists every variable.

> [!NOTE]
> The public demo runs exactly this way on a single server, with a few
> demo-specific additions (visitor accounts, nightly reset). Its setup lives in
> `deploy/demo/` in the repository and is a working example of everything
> below.

## Components

```
Internet ──443──▶ reverse proxy (TLS)
                   ├─ wiki.example.org  → web :3000   (app; proxies /api /auth /admin /media /webhooks /drawio /mcp)
                   └─ git.example.org   → Forgejo :3000   (only if Forgejo hosts the spaces)
internal network: web · api · mcp · drawio · postgres · forgejo
```

| Component | State | Backup |
|---|---|---|
| Reverse proxy (Caddy, Traefik, nginx) | certificates | not needed |
| `web`, `api`, `mcp`, `drawio` | none | not needed |
| `postgres` | index, sessions, encrypted Git tokens | optional — rebuilt from Git by a reindex |
| Forgejo (`forgejo-data`) | **all page content**, accounts | **required** |

If the spaces live on GitHub or an existing Forgejo, the Git part runs
elsewhere and this server only runs the app.

## Sizing

- **Small team (up to a few hundred pages):** 2 vCPU, 4 GB RAM, 40 GB disk is
  enough when the server *pulls* images. Building the web image on the server
  needs about 4 GB on its own — don't build there.
- **Growing:** RAM is the first limit (Postgres cache, Next.js). 8 GB leaves
  room for Forgejo on the same host.
- Disk grows with the Git repositories (diagrams and images count most), not
  with the database.

## Host

1. A current Linux (Debian or Ubuntu LTS) with Docker Engine and the Compose
   plugin; automatic security updates.
2. A service user for the stack (member of `docker`) and an admin account with
   `sudo`. SSH with keys only.
3. Firewall: inbound **80 and 443 only** (plus SSH, ideally restricted by
   source). The app containers publish their ports on `127.0.0.1` or not at
   all — Docker's published ports bypass host firewalls such as `ufw`, so
   binding to localhost is the real protection.
4. Log rotation for Docker (`json-file` with `max-size`).

## TLS and host names

- One name for the app, e.g. `wiki.example.org`; one for Forgejo if it runs
  here, e.g. `git.example.org`.
- The reverse proxy terminates TLS (Let's Encrypt) and forwards to `web:3000`
  and `forgejo:3000`. `web` itself proxies `/api`, `/auth`, `/admin`, `/media`,
  `/webhooks`, `/drawio` and `/mcp` to the internal services — the proxy needs
  only these two routes.
- `F451_PUBLIC_BASE_URL=https://wiki.example.org`.
- **Never** set `F451_INSECURE_COOKIES` or `F451_OIDC_ALLOW_INSECURE` in
  production — they exist for local HTTP only.
- Let the proxy hold requests while a container restarts (in Caddy:
  `lb_try_duration`), so an update doesn't show errors to readers.

## Sign-in

Pick one identity provider — see [[sign-in-options]]:

- **Microsoft Entra ID** for company deployments ([[entra-id]]). Let Forgejo
  use Entra as its authentication source too, so the same people exist on both
  sides; users then link their Forgejo account once.
- **Forgejo as identity provider** when there is no company directory
  ([[forgejo-identity-provider]]) — one OAuth app for sign-in and linking makes
  it a single step.
- **GitHub** when the spaces live on GitHub ([[github-sign-in]]).

`F451_TOKEN_KEY` (32 random bytes, base64) encrypts the stored Git tokens.
Generate it once and keep it: a new key makes every linked account invalid.

## Images

Use the released images instead of building:

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.registry.yml
export F451_REGISTRY=ghcr.io/rotecodefraktion F451_TAG=1.0.0
docker compose pull
```

`F451_TAG` pins a version; update by changing it. Every release is listed in
`CHANGELOG.md`.

## First start

```sh
docker compose up -d postgres
docker compose run --rm api node dist/db/migrate-cli.js
docker compose up -d
curl -X POST -H "Authorization: Bearer $F451_ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{}' https://wiki.example.org/admin/reindex
```

Then set up webhooks in each space repository, so changes made directly in Git
show up at once: `https://wiki.example.org/webhooks/forgejo` or
`https://wiki.example.org/webhooks/github` (content type JSON, push and pull
request events).

Use the secret from `F451_WEBHOOK_SECRET_FORGEJO` / `F451_WEBHOOK_SECRET_GITHUB`
as the webhook secret. Without webhooks the drift job catches up every five
minutes — enough for many teams.

## Backups

- **Back up the Forgejo data volume** (or rely on your Git hosting's backups
  when the spaces live on GitHub). Daily, off the server, with a tested
  restore — see [[backup-and-restore]].
- Keep the configuration (`.env`, compose overrides, proxy config) in a private
  repository or password manager — it holds the secrets and the OAuth app.
- Postgres needs no backup for content. A dump saves the reindex time and
  keeps linked accounts; losing it only logs everyone out.

## Updates

1. Read the release notes in `CHANGELOG.md`.
2. Set the new `F451_TAG`, `docker compose pull`.
3. **Run the migration before switching over:**
   `docker compose run --rm api node dist/db/migrate-cli.js`.
4. `docker compose up -d`. The API finishes running requests before it stops.
5. If the notes ask for it, run a reindex.

## Monitoring

- `GET /readyz` on the API for the health check (database reachable).
- `GET /admin/status` (with `F451_ADMIN_TOKEN`) for webhook, indexer and drift
  error counters — see [[operations]].
- Certificate expiry and free disk space on the host.
- An external uptime check on the app's start page.

## Checklist

- [ ] HTTPS on both names, no insecure flags set
- [ ] Only 80/443 (and restricted SSH) open; app ports on localhost
- [ ] Identity provider configured, button label set (`F451_OIDC_PROVIDER_NAME`)
- [ ] `F451_TOKEN_KEY`, `F451_ADMIN_TOKEN`, webhook secrets generated and stored safely
- [ ] Images pinned to a release (`F451_TAG`)
- [ ] Migration run, reindex run, webhooks set up
- [ ] Forgejo data backed up daily, restore tested once
- [ ] Health check and uptime monitoring in place
