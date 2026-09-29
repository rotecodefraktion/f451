#!/usr/bin/env bash
# ============================================================================
# f451 public demo — setup, update and nightly reset on a single server.
#
#   deploy/demo/demo.sh setup    first start: Forgejo, accounts, spaces, build
#   deploy/demo/demo.sh update   pull main if it moved (or --force), rebuild,
#                                migrate, restart, refresh the guides, reindex
#   deploy/demo/demo.sh reset    nightly: guides and playground back to demo/,
#                                open reviews closed, draft branches deleted
#   deploy/demo/demo.sh status   containers and the last deployed commit
#
# Configuration lives OUTSIDE the repository in $DEMO_ENV (default
# /opt/f451-demo/demo.env). The operator sets two lines before `setup`:
#
#   F451_DEMO_HOST=demo.example.org
#   F451_DEMO_GIT_HOST=git.demo.example.org
#
# `setup` appends everything else (secrets included) to that file. Keep it
# readable only by the operator. See deploy/demo/README.md.
# ============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_ENV="${DEMO_ENV:-/opt/f451-demo/demo.env}"
ORG=f451
ADMIN_USER=f451-admin
VISITOR_USER=demo
# Spaces: <id>:<name>. Each is demo/<id>/ in this repository.
SPACES=("user-guide:User Guide" "developer-guide:Developer Guide" "admin-guide:Admin Guide" "playground:Playground")
WRITABLE_SPACE=playground

say() { printf '\033[1;34m» %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$DEMO_ENV" ] || die "$DEMO_ENV not found — create it with F451_DEMO_HOST and F451_DEMO_GIT_HOST."
env_get() { grep -E "^$1=" "$DEMO_ENV" | tail -1 | cut -d= -f2- || true; }
env_set() {  # replace or append KEY=VALUE
  local key="$1" value="$2"
  if grep -qE "^$key=" "$DEMO_ENV"; then
    python3 - "$DEMO_ENV" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1:]
lines = open(path).read().splitlines()
open(path, 'w').write('\n'.join(f'{key}={value}' if l.startswith(key + '=') else l for l in lines) + '\n')
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$DEMO_ENV"
  fi
}
secret() { openssl rand -hex "${1:-24}"; }

HOST="$(env_get F451_DEMO_HOST)"; GIT_HOST="$(env_get F451_DEMO_GIT_HOST)"
[ -n "$HOST" ] && [ -n "$GIT_HOST" ] || die "F451_DEMO_HOST and F451_DEMO_GIT_HOST must be set in $DEMO_ENV."

compose() {
  docker compose -p f451demo --env-file "$DEMO_ENV" \
    -f "$REPO/deploy/git/docker-compose.yml" \
    -f "$REPO/deploy/wiki/docker-compose.yml" \
    -f "$REPO/deploy/demo/docker-compose.demo.yml" "$@"
}

forgejo_local() { echo "http://127.0.0.1:$(env_get F451_FORGEJO_HTTP_PORT | cut -d: -f2)"; }
web_local() { echo "http://127.0.0.1:$(env_get F451_WEB_PORT | cut -d: -f2)"; }

fapi() {  # fapi METHOD PATH [JSON] — Forgejo API as the admin, via localhost
  local method="$1" path="$2" data="${3:-}"
  curl -sf -X "$method" -H "Authorization: token $(env_get F451_FORGEJO_TOKEN)" \
    -H 'Content-Type: application/json' ${data:+-d "$data"} "$(forgejo_local)/api/v1$path"
}

wait_for() {  # wait_for URL
  for _ in $(seq 90); do curl -sf -o /dev/null "$1" && return 0; sleep 2; done
  die "$1 not reachable"
}

spaces_json() {
  local out="" id
  for s in "${SPACES[@]}"; do
    id="${s%%:*}"
    out+="${out:+,}{\"id\":\"$id\",\"name\":\"${s#*:}\",\"provider\":\"forgejo\",\"owner\":\"$ORG\",\"repo\":\"$id\",\"defaultLang\":\"en\"}"
  done
  printf '[%s]' "$out"
}

# --- configuration -----------------------------------------------------------

write_static_config() {
  env_set F451_FORGEJO_ROOT_URL "https://$GIT_HOST/"
  env_set F451_FORGEJO_URL "https://$GIT_HOST"
  env_set F451_PUBLIC_BASE_URL "https://$HOST"
  env_set F451_OIDC_ISSUER "https://$GIT_HOST/"
  env_set F451_OIDC_REDIRECT_URL "https://$HOST/auth/callback"
  env_set F451_OIDC_PROVIDER_NAME "Forgejo"
  # App ports only on localhost; Caddy is the only public entry.
  env_set F451_FORGEJO_HTTP_PORT "127.0.0.1:3300"
  env_set F451_FORGEJO_SSH_PORT "127.0.0.1:2222"
  env_set F451_WEB_PORT "127.0.0.1:8080"
  env_set F451_DRAWIO_PORT "127.0.0.1:8081"
  env_set F451_SPACES "'$(spaces_json)'"
  [ -n "$(env_get POSTGRES_PASSWORD)" ] || env_set POSTGRES_PASSWORD "$(secret)"
  [ -n "$(env_get F451_TOKEN_KEY)" ] || env_set F451_TOKEN_KEY "$(openssl rand -base64 32)"
  [ -n "$(env_get F451_ADMIN_TOKEN)" ] || env_set F451_ADMIN_TOKEN "$(secret)"
  [ -n "$(env_get F451_WEBHOOK_SECRET_FORGEJO)" ] || env_set F451_WEBHOOK_SECRET_FORGEJO "$(secret 16)"
}

setup_forgejo() {
  say "Forgejo: admin account, token, OAuth app, organisation, visitor account"
  compose up -d forgejo
  wait_for "$(forgejo_local)/api/healthz"

  if [ -z "$(env_get FORGEJO_ADMIN_PASSWORD)" ]; then
    env_set FORGEJO_ADMIN_PASSWORD "$(secret 16)"
    compose exec -T -u 1000 forgejo forgejo admin user create --admin \
      --username "$ADMIN_USER" --password "$(env_get FORGEJO_ADMIN_PASSWORD)" \
      --email "$ADMIN_USER@$GIT_HOST" --must-change-password=false >/dev/null
  fi
  if [ -z "$(env_get F451_FORGEJO_TOKEN)" ]; then
    env_set F451_FORGEJO_TOKEN "$(compose exec -T -u 1000 forgejo forgejo admin user generate-access-token \
      --username "$ADMIN_USER" --token-name "f451-service" --scopes all --raw | tr -d '\r\n')"
  fi

  if [ -z "$(env_get F451_OIDC_CLIENT_ID)" ]; then
    local app redirects="[\"https://$HOST/auth/callback\",\"https://$HOST/auth/connect/forgejo/callback\"]"
    app=$(fapi POST /user/applications/oauth2 "{\"name\":\"f451-demo\",\"redirect_uris\":$redirects,\"confidential_client\":true}")
    local id secret_
    id=$(echo "$app" | python3 -c 'import sys,json;print(json.load(sys.stdin)["client_id"])')
    secret_=$(echo "$app" | python3 -c 'import sys,json;print(json.load(sys.stdin)["client_secret"])')
    # One OAuth app for sign-in AND the Forgejo connection → one-step sign-in.
    env_set F451_OIDC_CLIENT_ID "$id";  env_set F451_OIDC_CLIENT_SECRET "$secret_"
    env_set F451_FORGEJO_OAUTH_CLIENT_ID "$id"; env_set F451_FORGEJO_OAUTH_CLIENT_SECRET "$secret_"
  fi

  fapi GET "/orgs/$ORG" >/dev/null || fapi POST /orgs "{\"username\":\"$ORG\",\"visibility\":\"public\"}" >/dev/null

  if [ -z "$(env_get DEMO_VISITOR_PASSWORD)" ]; then
    env_set DEMO_VISITOR_PASSWORD "$(secret 8)"
    compose exec -T -u 1000 forgejo forgejo admin user create \
      --username "$VISITOR_USER" --password "$(env_get DEMO_VISITOR_PASSWORD)" \
      --email "$VISITOR_USER@$GIT_HOST" --must-change-password=false >/dev/null
  fi
}

ensure_repos() {
  local id
  for s in "${SPACES[@]}"; do
    id="${s%%:*}"
    fapi GET "/repos/$ORG/$id" >/dev/null || fapi POST "/orgs/$ORG/repos" \
      "{\"name\":\"$id\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}" >/dev/null
  done
  # Visitors may write only in the playground: a team with write access to it.
  local team
  team=$(fapi GET "/orgs/$ORG/teams/search?q=visitors" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d[0]["id"] if d else "")')
  if [ -z "$team" ]; then
    team=$(fapi POST "/orgs/$ORG/teams" '{"name":"visitors","permission":"write","units":["repo.code","repo.pulls"],"includes_all_repositories":false}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  fi
  fapi PUT "/teams/$team/repos/$ORG/$WRITABLE_SPACE" >/dev/null
  fapi PUT "/teams/$team/members/$VISITOR_USER" >/dev/null
}

# --- content -----------------------------------------------------------------

# Push demo/<space>/ as the new state of main (only if something changed).
seed() {
  say "Content: demo/* → Forgejo"
  local tmp id token; tmp=$(mktemp -d); token="$(env_get F451_FORGEJO_TOKEN)"
  local base; base="$(forgejo_local | sed "s|http://|http://$ADMIN_USER:$token@|")"
  for s in "${SPACES[@]}"; do
    id="${s%%:*}"
    git clone -q "$base/$ORG/$id.git" "$tmp/$id"
    find "$tmp/$id" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    cp -R "$REPO/demo/$id/." "$tmp/$id/"
    if [ -n "$(git -C "$tmp/$id" status --porcelain)" ]; then
      git -C "$tmp/$id" add -A
      git -C "$tmp/$id" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_USER@$GIT_HOST" \
        commit -qm "Demo content from demo/$id ($(git -C "$REPO" rev-parse --short HEAD))"
      git -C "$tmp/$id" push -q origin main
      echo "  ✓ $id"
    else
      echo "  = $id"
    fi
  done
  rm -rf "$tmp"
}

# Close open reviews and delete draft branches (nightly reset).
clear_drafts() {
  say "Reviews and drafts: closing and deleting"
  local id
  for s in "${SPACES[@]}"; do
    id="${s%%:*}"
    for n in $(fapi GET "/repos/$ORG/$id/pulls?state=open&limit=50" | python3 -c 'import sys,json;print(" ".join(str(p["number"]) for p in json.load(sys.stdin)))'); do
      fapi PATCH "/repos/$ORG/$id/pulls/$n" '{"state":"closed"}' >/dev/null && echo "  ✕ $id PR $n"
    done
    for b in $(fapi GET "/repos/$ORG/$id/branches?limit=50" | python3 -c 'import sys,json;print(" ".join(b["name"] for b in json.load(sys.stdin) if b["name"].startswith("draft/")))'); do
      fapi DELETE "/repos/$ORG/$id/branches/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$b")" >/dev/null && echo "  ✕ $id $b"
    done
  done
}

reindex() {
  say "Reindex"
  wait_for "$(web_local)/"
  curl -sf -X POST -H "Authorization: Bearer $(env_get F451_ADMIN_TOKEN)" -H 'Content-Type: application/json' \
    -d '{}' "$(web_local)/admin/reindex" | python3 -c '
import sys, json
for r in json.load(sys.stdin):
    rep = r["report"]
    print(f"  {r[\"space\"]}: {rep[\"pagesIndexed\"]} pages, {rep[\"pagesWithErrors\"]} errors, {rep[\"brokenLinks\"]} broken links")'
}

deploy() {
  say "Build, migrate, start"
  compose build web api mcp
  compose up -d postgres
  compose run --rm api node dist/db/migrate-cli.js
  compose up -d
  git -C "$REPO" rev-parse HEAD > "$(dirname "$DEMO_ENV")/deployed-commit"
}

# --- commands ----------------------------------------------------------------

case "${1:-}" in
  setup)
    write_static_config
    setup_forgejo
    ensure_repos
    seed
    deploy
    reindex
    printf '\n\033[1;32m✓ Demo: https://%s — visitor login %s / %s\033[0m\n' "$HOST" "$VISITOR_USER" "$(env_get DEMO_VISITOR_PASSWORD)"
    ;;
  update)
    git -C "$REPO" fetch -q origin main
    deployed="$(cat "$(dirname "$DEMO_ENV")/deployed-commit" 2>/dev/null || true)"
    target="$(git -C "$REPO" rev-parse origin/main)"
    if [ "$deployed" = "$target" ] && [ "${2:-}" != "--force" ]; then exit 0; fi
    say "Update ${deployed:0:7} → ${target:0:7}"
    git -C "$REPO" checkout -q main && git -C "$REPO" merge -q --ff-only origin/main
    write_static_config
    ensure_repos
    deploy
    seed
    reindex
    ;;
  reset)
    clear_drafts
    seed
    reindex
    ;;
  status)
    compose ps --format 'table {{.Service}}\t{{.Status}}'
    echo "deployed: $(cat "$(dirname "$DEMO_ENV")/deployed-commit" 2>/dev/null || echo -)"
    ;;
  *)
    sed -n '4,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
