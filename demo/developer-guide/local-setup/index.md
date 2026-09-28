---
id: local-setup
title: Local setup
description: Get a working f451 stack on your machine, and the commands you'll use daily.
tags: [setup, getting-started]
lang: en
---

# Local setup

f451 needs Node 22 and pnpm 9, plus Docker (or Podman) for the two stacks
it runs locally: a Forgejo instance for content and sign-in, and the wiki
itself.

> [!NOTE]
> This mirrors the top-level `README.md`. If the two ever disagree, the
> README is authoritative — this page exists so the setup steps sit next
> to the rest of the developer documentation.

## Why not `localhost`

The browser and the containers must reach Forgejo and the wiki under the
*same* address, because inside a container `localhost` means the container
itself, not your machine. Pick your machine's LAN address once and use it
everywhere below (called `<IP>`).

## Steps

1. **Start Forgejo first.** It must be running before the wiki stack, since
   the wiki authenticates against it.

   ```
   cat > deploy/git/docker-compose.override.yml <<EOF
   services:
     forgejo:
       environment:
         FORGEJO__server__ROOT_URL: http://<IP>:3300/
   EOF
   docker compose -f deploy/git/docker-compose.yml up -d
   ```

2. **Run the setup script.** It creates an admin account, an organization,
   an OAuth app and a demo space, and writes `deploy/wiki/.env`:

   ```
   FORGEJO_URL=http://<IP>:3300 WEB_BASE=http://<IP>:8080 ./scripts/dev-local-setup.sh
   ```

3. **Start the wiki:**

   ```
   cd deploy/wiki && docker compose up -d --build
   ```

4. **Open** `http://<IP>:8080`, sign in through Forgejo
   (`wiki-admin` / `admin1234`), then link your Forgejo account under
   *Settings → Connections*. Spaces only become visible and writable once
   your account is linked — this is the "permissions come from the Git
   provider" rule from [[principles]] in practice.

> [!WARNING]
> This setup is for local development only: plain HTTP, insecure cookies.
> It is not meant to be exposed beyond your machine.

Database migrations do not run automatically after an update; run
`docker compose run --rm api node dist/db/migrate-cli.js`.

## Everyday commands

Once the stack is up, most development happens outside Docker:

| Purpose | Command |
|---|---|
| Type-check every package | `pnpm -w typecheck` |
| Run every test | `pnpm -w test` |
| Run one test file | `pnpm --filter @f451/web test -- lib/urls.test.ts` |
| API in dev mode (port 3001) | `pnpm --filter @f451/api dev` |
| Web in dev mode (port 3000) | `pnpm --filter @f451/web dev` |
| Generate a database migration | `pnpm --filter @f451/api db:generate` |
| CSS metrics with bounds | `pnpm css:inventar` |

For what to actually run before opening a pull request, see
[[testing-and-contributing]] — it is a much shorter list than "everything
above".
