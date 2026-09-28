#!/usr/bin/env bash
# Legt Admin-Konto und Test-Org in der lokalen Forgejo-Dev-Instanz an.
# Voraussetzung: deploy/git-Stack läuft (docker compose -f deploy/git/docker-compose.yml up -d)
set -euo pipefail

COMPOSE="docker compose -f deploy/git/docker-compose.yml"
ADMIN_USER="wiki-admin"
ADMIN_PASS="${FORGEJO_ADMIN_PASS:-admin1234}"
ADMIN_MAIL="wiki-admin@example.local"
MAX_TRIES="${MAX_TRIES:-60}"

echo "Warte auf Forgejo…"
tries=0
until curl -sf http://localhost:3300/api/healthz >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge "$MAX_TRIES" ]; then
    echo "Fehler: Forgejo nach $MAX_TRIES Versuchen (~$((MAX_TRIES * 2))s) nicht erreichbar." >&2
    exit 1
  fi
  sleep 2
done

echo "Lege Admin-Konto an (idempotent)…"
if ! CREATE_OUTPUT=$($COMPOSE exec -T -u 1000 forgejo forgejo admin user create \
  --admin --username "$ADMIN_USER" --password "$ADMIN_PASS" --email "$ADMIN_MAIL" 2>&1); then
  if echo "$CREATE_OUTPUT" | grep -qi "already exists"; then
    echo "Konto existiert bereits — ok"
  else
    echo "Fehler beim Anlegen des Admin-Kontos: $CREATE_OUTPUT" >&2
    exit 1
  fi
fi

echo "Erzeuge API-Token…"
TOKEN=$($COMPOSE exec -T -u 1000 forgejo forgejo admin user generate-access-token \
  --username "$ADMIN_USER" --token-name "dev-$(date +%s)" --scopes all --raw)
[ -n "$TOKEN" ] || { echo "Fehler: Kein API-Token erzeugt." >&2; exit 1; }

echo "Lege Test-Org 'dev-docs' an (idempotent)…"
if curl -sf -H "Authorization: token $TOKEN" http://localhost:3300/api/v1/orgs/dev-docs >/dev/null 2>&1; then
  echo "Org existiert bereits — ok"
else
  if ! curl -sf -X POST http://localhost:3300/api/v1/orgs \
    -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
    -d '{"username": "dev-docs"}' >/dev/null; then
    echo "Fehler beim Anlegen der Org 'dev-docs'." >&2
    exit 1
  fi
fi

echo
echo "Fertig. Login: $ADMIN_USER / $ADMIN_PASS auf http://localhost:3300"
echo "API-Token (für .env): $TOKEN"
