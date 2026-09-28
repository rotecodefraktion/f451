#!/usr/bin/env bash
# ============================================================================
# Bootstrap-Wrapper: fährt den GESAMTEN gebauten Stack von Null hoch (Forgejo
# + lokales OIDC-Setup + Wiki-Stack inkl. Image-Rebuild + DB-Migration) und
# fährt danach den Deployment-E2E-Gate (`scripts/deploy-e2e.mjs`) — EIN
# Kommando prüft reproduzierbar, ob „läuft" wirklich stimmt.
#
# Exit-Code = Exit-Code des E2E-Gates (0 = alle 11 Reise-Schritte bestanden,
# ≠0 = Bruch — das ist die Definition von „fertig", siehe
# docs/superpowers/HANDOFF-2026-07-16-deployment-e2e.md).
#
# `deploy/wiki/.env` ist MASCHINENSPEZIFISCH (LAN-IP, Secrets — siehe
# `scripts/dev-local-setup.sh`) und gitignored. Dieser Wrapper schreibt sie
# (Schritt 2) idempotent neu, überschreibt aber KEIN wiederverwendbares
# Secret (siehe `reuse_env` in `dev-local-setup.sh`).
#
# Nutzung (Defaults spiegeln die aktuell bekannte LAN-Instanz):
#   bash scripts/deploy-e2e-full.sh
#   WEB_BASE=http://<lan-ip>:8080 FORGEJO_URL=http://<lan-ip>:3300 \
#     bash scripts/deploy-e2e-full.sh
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Host-abhängige Basis-URLs — Defaults spiegeln die im Handoff dokumentierte
# LAN-Instanz, per Env für andere Maschinen überschreibbar.
WEB_BASE="${WEB_BASE:-http://localhost:8080}"
FORGEJO_URL="${FORGEJO_URL:-http://localhost:3300}"
GIT_COMPOSE="deploy/git/docker-compose.yml"
WIKI_COMPOSE="deploy/wiki/docker-compose.yml"
WIKI_ENV="deploy/wiki/.env"
# Host-spezifischer Override außerhalb des Repos (siehe HANDOFF): setzt
# `FORGEJO__server__ROOT_URL` auf die LAN-IP + lange OAuth-Token-TTL. Optional
# — existiert die Datei nicht (z. B. auf einer anderen Maschine oder bei
# Compose-Defaults=localhost), läuft Forgejo einfach mit den Compose-Defaults.
GIT_OVERRIDE_FILE="${GIT_OVERRIDE_FILE:-/tmp/git-override.yml}"

say() { printf '\033[1;34m» %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

# Wartet, bis ein Docker-Healthcheck für einen Compose-Service "healthy"
# meldet (Service OHNE Healthcheck bleibt hier bewusst außen vor — Forgejo hat
# im Compose-File Punkt 1 keinen, dafür die curl-Schleife unten).
wait_for_healthy() {
  local compose_file="$1" service="$2" timeout_s="${3:-180}"
  local waited=0 cid status
  while true; do
    cid="$(docker compose -f "$compose_file" ps -q "$service" 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "unknown")"
      [ "$status" = "healthy" ] && return 0
    else
      status="(kein Container)"
    fi
    if [ "$waited" -ge "$timeout_s" ]; then
      warn "$service nicht healthy nach ${timeout_s}s (Status: $status)."
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
}

# --- 1. Forgejo-Stack --------------------------------------------------------
say "Schritt 1/4: Forgejo-Stack …"
FORGEJO_CID="$(docker compose -f "$GIT_COMPOSE" ps -q forgejo 2>/dev/null || true)"
if [ -n "$FORGEJO_CID" ] && [ "$(docker inspect -f '{{.State.Running}}' "$FORGEJO_CID" 2>/dev/null)" = "true" ]; then
  say "  Forgejo läuft bereits — kein Neustart erzwungen."
else
  GIT_COMPOSE_ARGS=(-f "$GIT_COMPOSE")
  if [ -f "$GIT_OVERRIDE_FILE" ]; then
    say "  Override gefunden ($GIT_OVERRIDE_FILE, LAN-ROOT_URL + lange OAuth-TTL) — wird verwendet."
    GIT_COMPOSE_ARGS+=(-f "$GIT_OVERRIDE_FILE")
  else
    say "  Kein Override unter $GIT_OVERRIDE_FILE — Forgejo startet mit Compose-Defaults (ROOT_URL=localhost)."
    warn "  Falls WEB_BASE/FORGEJO_URL eine LAN-IP referenzieren, muss Forgejos ROOT_URL dazu passen"
    warn "  (sonst schlägt der OIDC-Redirect fehl) — ggf. eigene Override-Datei per GIT_OVERRIDE_FILE setzen."
  fi
  docker compose "${GIT_COMPOSE_ARGS[@]}" up -d
fi

say "  Warte auf Forgejo (${FORGEJO_URL}/api/healthz) …"
FORGEJO_UP=0
for _ in $(seq 1 30); do
  if curl -sf "${FORGEJO_URL}/api/healthz" >/dev/null 2>&1; then
    FORGEJO_UP=1
    break
  fi
  sleep 2
done
[ "$FORGEJO_UP" -eq 1 ] || die "Forgejo unter ${FORGEJO_URL} nicht erreichbar (Timeout)."

# --- 2. Idempotentes lokales Setup (OAuth-App, Demo-Space, deploy/wiki/.env) -
say "Schritt 2/4: scripts/dev-local-setup.sh (idempotent) …"
FORGEJO_URL="$FORGEJO_URL" WEB_BASE="$WEB_BASE" ./scripts/dev-local-setup.sh

# --- 3. Wiki-Stack: Build + Up + Migration + Health-Wait ---------------------
say "Schritt 3/4: Wiki-Stack (Build + Up) — kann einige Minuten dauern …"
docker compose -f "$WIKI_COMPOSE" --env-file "$WIKI_ENV" up -d --build

say "  Migriere Datenbank (idempotent — wendet nur ausstehende Migrationen an) …"
docker compose -f "$WIKI_COMPOSE" --env-file "$WIKI_ENV" run --rm api node dist/db/migrate-cli.js

say "  Warte auf api healthy …"
wait_for_healthy "$WIKI_COMPOSE" api 240 || die "api wurde nicht healthy — siehe: docker compose -f $WIKI_COMPOSE logs api"
say "  Warte auf web healthy …"
wait_for_healthy "$WIKI_COMPOSE" web 120 || die "web wurde nicht healthy — siehe: docker compose -f $WIKI_COMPOSE logs web"

# --- 4. Deployment-E2E-Gate ---------------------------------------------------
say "Schritt 4/4: Deployment-E2E-Gate (scripts/deploy-e2e.mjs) …"
set +e
WEB_BASE="$WEB_BASE" FORGEJO_BASE="$FORGEJO_URL" node scripts/deploy-e2e.mjs
E2E_EXIT=$?
set -e

if [ "$E2E_EXIT" -eq 0 ]; then
  say "GATE GRÜN — voller Deployment-Stack + Nutzerreise (Login…Merge) bestanden."
else
  warn "GATE ROT (Exit $E2E_EXIT) — siehe e2e-artifacts/FAIL-*.{png,html,log} für Belege."
fi
exit "$E2E_EXIT"
