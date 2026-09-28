# Forgejo-Dev-Instanz

Lokale Git-Infrastruktur für Entwicklung und Adapter-Contract-Tests.

## Start

    docker compose -f deploy/git/docker-compose.yml up -d
    ./scripts/forgejo-dev-setup.sh

Danach: http://localhost:3300 (Login `wiki-admin` / `admin1234`,
überschreibbar via `FORGEJO_ADMIN_PASS`).

Das Skript ist idempotent und gibt einen API-Token aus (für Phase-1-Adapter).

## Produktion (Ausblick, siehe Spec Abschnitt 8)

In Produktion läuft Forgejo mit Entra-OIDC als Auth-Quelle; `forgejo-data`
ist das einzige Backup-kritische Volume der Gesamtplattform.

## Second instance on the same host

Ports and root URL are configurable, so a second Forgejo (e.g. for a demo)
can run under its own compose project name:

    F451_FORGEJO_HTTP_PORT=3310 F451_FORGEJO_SSH_PORT=2232 \
    F451_FORGEJO_ROOT_URL=http://<host>:3310/ \
      docker compose -p demo-git -f deploy/git/docker-compose.yml up -d

The wiki stack works the same way (`F451_WEB_PORT`, `F451_DRAWIO_PORT`,
`F451_COOKIE_PREFIX`, see `deploy/wiki/.env.example`).
