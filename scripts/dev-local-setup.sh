#!/usr/bin/env bash
# ============================================================================
# Lokaler Betrieb OHNE Entra: Forgejo als OIDC-Login- UND Connect-Provider,
# plus ein befüllter Demo-Space. Idempotent — mehrfach ausführbar.
#
# Voraussetzung: der Forgejo-Dev-Stack läuft
#   docker compose -f deploy/git/docker-compose.yml up -d
#
# Ergebnis: geschriebene deploy/wiki/.env + ein export-Block für den Host-Dev-Flow.
#
# SICHERHEIT: Dieser Modus ist ausschließlich für lokale Entwicklung gedacht
# (HTTP, F451_INSECURE_COOKIES=1, F451_OIDC_ALLOW_INSECURE=1). NIEMALS in
# Produktion verwenden — dort ist Entra der IdP (siehe deploy/BETRIEB.md).
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGEJO_URL="${FORGEJO_URL:-http://localhost:3300}"
COMPOSE="docker compose -f $REPO_ROOT/deploy/git/docker-compose.yml"
ADMIN_USER="wiki-admin"
ADMIN_PASS="${FORGEJO_ADMIN_PASS:-admin1234}"
ADMIN_MAIL="wiki-admin@example.local"
ORG="dev-docs"
SPACE_REPO="betrieb"
OAUTH_APP_NAME="f451-wiki-dev"
# Host-Dev-Basis (Browser) — Web proxyt /auth,/api,/admin,/media zur API.
WEB_BASE="${WEB_BASE:-http://localhost:3000}"
ENV_FILE="$REPO_ROOT/deploy/wiki/.env"

say() { printf '\033[1;34m» %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Forgejo erreichbar? --------------------------------------------------
say "Prüfe Forgejo unter $FORGEJO_URL …"
if ! curl -sf "$FORGEJO_URL/api/healthz" >/dev/null 2>&1; then
  die "Forgejo nicht erreichbar. Zuerst starten:
       docker compose -f deploy/git/docker-compose.yml up -d"
fi

# --- 1. Admin + Service-Token (idempotent) -----------------------------------
say "Stelle Admin-Konto '$ADMIN_USER' sicher …"
if ! CREATE_OUT=$($COMPOSE exec -T -u 1000 forgejo forgejo admin user create \
  --admin --username "$ADMIN_USER" --password "$ADMIN_PASS" --email "$ADMIN_MAIL" 2>&1); then
  echo "$CREATE_OUT" | grep -qi "already exists" || die "Admin-Anlage fehlgeschlagen: $CREATE_OUT"
  echo "  Konto existiert bereits — ok"
fi

say "Erzeuge Service-Token (Indexer/Lesen) …"
SERVICE_TOKEN=$($COMPOSE exec -T -u 1000 forgejo forgejo admin user generate-access-token \
  --username "$ADMIN_USER" --token-name "dev-service-$(date +%s)" --scopes all --raw)
[ -n "$SERVICE_TOKEN" ] || die "Kein Service-Token erzeugt."

auth_hdr=(-H "Authorization: token $SERVICE_TOKEN")

# --- 2. Org (idempotent) -----------------------------------------------------
say "Stelle Org '$ORG' sicher …"
if ! curl -sf "${auth_hdr[@]}" "$FORGEJO_URL/api/v1/orgs/$ORG" >/dev/null 2>&1; then
  curl -sf -X POST "${auth_hdr[@]}" -H "Content-Type: application/json" \
    -d "{\"username\": \"$ORG\"}" "$FORGEJO_URL/api/v1/orgs" >/dev/null \
    || die "Org-Anlage fehlgeschlagen."
fi

# --- 3. OAuth2-App (idempotent: erst nach Namen suchen) ----------------------
say "Stelle OAuth2-App '$OAUTH_APP_NAME' sicher (Login + Connect) …"
REDIRECTS="[\"$WEB_BASE/auth/callback\",\"$WEB_BASE/auth/connect/forgejo/callback\",\"http://localhost:8080/auth/callback\",\"http://localhost:8080/auth/connect/forgejo/callback\"]"
EXISTING_ID=$(curl -sf "${auth_hdr[@]}" "$FORGEJO_URL/api/v1/user/applications/oauth2" \
  | python3 -c "import sys,json;
apps=json.load(sys.stdin)
print(next((str(a['id']) for a in apps if a.get('name')=='$OAUTH_APP_NAME'), ''))" 2>/dev/null || echo "")

CLIENT_ID=""; CLIENT_SECRET=""
if [ -n "$EXISTING_ID" ]; then
  # Stabile client_id aus der Liste holen; Secret gibt Forgejo NUR bei
  # Anlage/PATCH preis. Um einen bereits laufenden Stack NICHT zu brechen
  # (Secret-Rotation → Token-Tausch scheitert), wird ein zuvor geschriebenes
  # Secret aus $ENV_FILE wiederverwendet, wenn die client_id übereinstimmt.
  CLIENT_ID=$(curl -sf "${auth_hdr[@]}" "$FORGEJO_URL/api/v1/user/applications/oauth2/$EXISTING_ID" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('client_id',''))")
  if [ -f "$ENV_FILE" ] && grep -q "F451_OIDC_CLIENT_ID=$CLIENT_ID" "$ENV_FILE"; then
    CLIENT_SECRET=$(grep '^F451_OIDC_CLIENT_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    echo "  App existiert (id $EXISTING_ID) — vorhandenes Secret aus $ENV_FILE wiederverwendet (keine Rotation)."
  fi
  if [ -z "$CLIENT_SECRET" ]; then
    echo "  App existiert (id $EXISTING_ID), aber kein passendes Secret gespeichert — erzeuge neues (bereits laufende API danach neu starten!) …"
    APP_JSON=$(curl -sf -X PATCH "${auth_hdr[@]}" -H "Content-Type: application/json" \
      -d "{\"name\":\"$OAUTH_APP_NAME\",\"redirect_uris\":$REDIRECTS,\"confidential_client\":true}" \
      "$FORGEJO_URL/api/v1/user/applications/oauth2/$EXISTING_ID")
    CLIENT_ID=$(echo "$APP_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['client_id'])")
    CLIENT_SECRET=$(echo "$APP_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('client_secret',''))")
  fi
else
  APP_JSON=$(curl -sf -X POST "${auth_hdr[@]}" -H "Content-Type: application/json" \
    -d "{\"name\":\"$OAUTH_APP_NAME\",\"redirect_uris\":$REDIRECTS,\"confidential_client\":true}" \
    "$FORGEJO_URL/api/v1/user/applications/oauth2")
  CLIENT_ID=$(echo "$APP_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['client_id'])")
  CLIENT_SECRET=$(echo "$APP_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('client_secret',''))")
fi
[ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] || die "OAuth2-App lieferte kein Client-Paar."

# --- 4. Demo-Space-Repo + Seed-Inhalt (idempotent) ---------------------------
say "Stelle Demo-Space-Repo '$ORG/$SPACE_REPO' sicher …"
if ! curl -sf "${auth_hdr[@]}" "$FORGEJO_URL/api/v1/repos/$ORG/$SPACE_REPO" >/dev/null 2>&1; then
  curl -sf -X POST "${auth_hdr[@]}" -H "Content-Type: application/json" \
    -d "{\"name\":\"$SPACE_REPO\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}" \
    "$FORGEJO_URL/api/v1/orgs/$ORG/repos" >/dev/null || die "Repo-Anlage fehlgeschlagen."
fi

put_file() {  # $1 = repo-pfad, $2 = lokale datei
  local path="$1" local_file="$2"
  local b64; b64=$(base64 < "$local_file" | tr -d '\n')
  # existierende Datei? → sha holen und aktualisieren, sonst anlegen (idempotent)
  local sha; sha=$(curl -sf "${auth_hdr[@]}" \
    "$FORGEJO_URL/api/v1/repos/$ORG/$SPACE_REPO/contents/$path?ref=main" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('sha',''))" 2>/dev/null || echo "")
  local method=POST payload
  payload="{\"content\":\"$b64\",\"message\":\"seed: $path\",\"branch\":\"main\""
  if [ -n "$sha" ]; then method=PUT; payload="$payload,\"sha\":\"$sha\""; fi
  payload="$payload}"
  curl -sf -X "$method" "${auth_hdr[@]}" -H "Content-Type: application/json" \
    -d "$payload" "$FORGEJO_URL/api/v1/repos/$ORG/$SPACE_REPO/contents/$path" >/dev/null \
    || die "Seed für '$path' fehlgeschlagen."
  echo "  ✓ $path"
}

# Seiten sind verzeichnisbasiert: <id>/index.md ist die Seite <id>
# (der Indexer erkennt ausschließlich index.md, s. index-space.ts#isPageFile).
say "Seede Demo-Inhalt …"
put_file "index.md"                       "$REPO_ROOT/scripts/seed/index.md"
put_file "onboarding/index.md"            "$REPO_ROOT/scripts/seed/onboarding/index.md"
put_file "richtlinien/index.md"           "$REPO_ROOT/scripts/seed/richtlinien/index.md"
put_file "_media/architektur.drawio.svg"  "$REPO_ROOT/scripts/seed/_media/architektur.drawio.svg"

# --- 5. Token-Key + .env schreiben -------------------------------------------
say "Schreibe $ENV_FILE …"
# Idempotent: Schlüssel/Secrets aus einer vorhandenen .env wiederverwenden —
# eine Rotation würde verschlüsselte Provider-Tokens unbrauchbar machen bzw.
# eine laufende API entkoppeln.
reuse_env() { [ -f "$ENV_FILE" ] && grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
TOKEN_KEY="$(reuse_env F451_TOKEN_KEY)";        [ -n "$TOKEN_KEY" ]      || TOKEN_KEY=$(openssl rand -base64 32)
WEBHOOK_SECRET="$(reuse_env F451_WEBHOOK_SECRET_FORGEJO)"; [ -n "$WEBHOOK_SECRET" ] || WEBHOOK_SECRET=$(openssl rand -hex 16)
ADMIN_API_TOKEN="$(reuse_env F451_ADMIN_TOKEN)"; [ -n "$ADMIN_API_TOKEN" ] || ADMIN_API_TOKEN=$(openssl rand -hex 16)
cat > "$ENV_FILE" <<ENV
# ============================================================================
# LOKALER DEV-MODUS OHNE ENTRA — erzeugt von scripts/dev-local-setup.sh
# NICHT für Produktion (HTTP, unsichere Cookies, Forgejo-OIDC).
# ============================================================================
POSTGRES_PASSWORD=wiki-dev

# Demo-Space im lokalen Forgejo. Single-Quotes: docker-compose entfernt die
# äußeren, bash 'source' behält den JSON-Inhalt (die inneren Doppelquotes)
# unverändert — ohne sie zerlegt 'source' das JSON.
F451_SPACES='[{"id":"betrieb","name":"Betrieb","provider":"forgejo","owner":"$ORG","repo":"$SPACE_REPO","defaultLang":"de"}]'
F451_FORGEJO_URL=$FORGEJO_URL
F451_FORGEJO_TOKEN=$SERVICE_TOKEN
F451_WEBHOOK_SECRET_FORGEJO=$WEBHOOK_SECRET
F451_ADMIN_TOKEN=$ADMIN_API_TOKEN

# Login via Forgejo-OIDC (statt Entra)
F451_OIDC_ISSUER=$FORGEJO_URL/
F451_OIDC_CLIENT_ID=$CLIENT_ID
F451_OIDC_CLIENT_SECRET=$CLIENT_SECRET
F451_OIDC_REDIRECT_URL=$WEB_BASE/auth/callback
F451_TOKEN_KEY=$TOKEN_KEY
F451_PUBLIC_BASE_URL=$WEB_BASE

# "Forgejo verbinden" (Nutzer-Token für Entwürfe) — dieselbe OAuth2-App
F451_FORGEJO_OAUTH_CLIENT_ID=$CLIENT_ID
F451_FORGEJO_OAUTH_CLIENT_SECRET=$CLIENT_SECRET

# Dev-only-Lockerungen
F451_INSECURE_COOKIES=1
F451_OIDC_ALLOW_INSECURE=1
ENV

# --- 6. Next-Steps -----------------------------------------------------------
cat <<NEXT

$(printf '\033[1;32m✓ Lokales Setup fertig.\033[0m')

Demo-Space:  $ORG/$SPACE_REPO  (Seiten: index, onboarding, richtlinien + Diagramm)
Login:       $ADMIN_USER / $ADMIN_PASS  (Forgejo-Konto)
OAuth2-App:  $OAUTH_APP_NAME  (client_id $CLIENT_ID)

Host-Dev-Flow starten (Terminal A + B), Env aus deploy/wiki/.env:

  set -a; source deploy/wiki/.env; set +a
  export DATABASE_URL=postgres://postgres:smoke@127.0.0.1:55432/f451   # oder eigene DB
  pnpm --filter @f451/api db:migrate
  # Terminal A:
  PORT=3001 pnpm --filter @f451/api dev
  # Terminal B:
  API_URL=http://127.0.0.1:3001 pnpm --filter @f451/web dev

Dann http://localhost:3000 öffnen → "Anmelden" → Forgejo-Login ($ADMIN_USER).

NEXT
