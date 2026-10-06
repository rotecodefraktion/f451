#!/usr/bin/env bash
# ============================================================================
# f451 public demo — setup, update and nightly reset on a single server.
#
#   deploy/demo/demo.sh setup    first start: Forgejo, accounts, spaces, build
#   deploy/demo/demo.sh update   pull main if it moved (or --force), rebuild,
#                                migrate, restart, refresh the guides, reindex
#   deploy/demo/demo.sh reset    nightly: guides and playground back to demo/,
#                                open reviews closed, draft branches deleted
#   deploy/demo/demo.sh apply    deploy the checked-out commit (used by update)
#   deploy/demo/demo.sh stats    update the visitor statistics at /stats/
#   deploy/demo/demo.sh guard    recreate a visitor account that no longer signs in
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
# Visitor accounts: "demo" reads every space, "writer" may also write in the playground.
READER_USER=demo
WRITER_USER=writer
# Spaces: <id>:<name>. Each is demo/<id>/ in this repository.
SPACES=("user-guide:User Guide" "developer-guide:Developer Guide" "admin-guide:Admin Guide" "playground:Playground")
WRITABLE_SPACE=playground
# Instance repository (instance theme); its content is deploy/demo/instance/.
INSTANCE_REPO=instance

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
  env_set F451_CUSTOM_STYLESHEET "/custom/theme.css"
  # App ports only on localhost; Caddy is the only public entry.
  env_set F451_FORGEJO_HTTP_PORT "127.0.0.1:3300"
  env_set F451_FORGEJO_SSH_PORT "127.0.0.1:2222"
  env_set F451_WEB_PORT "127.0.0.1:8080"
  env_set F451_DRAWIO_PORT "127.0.0.1:8081"
  env_set F451_SPACES "'$(spaces_json)'"
  env_set F451_INSTANCE_CONFIG "'{\"provider\":\"forgejo\",\"owner\":\"$ORG\",\"repo\":\"$INSTANCE_REPO\"}'"
  [ -n "$(env_get POSTGRES_PASSWORD)" ] || env_set POSTGRES_PASSWORD "$(secret)"
  [ -n "$(env_get F451_TOKEN_KEY)" ] || env_set F451_TOKEN_KEY "$(openssl rand -base64 32)"
  [ -n "$(env_get F451_ADMIN_TOKEN)" ] || env_set F451_ADMIN_TOKEN "$(secret)"
  [ -n "$(env_get F451_WEBHOOK_SECRET_FORGEJO)" ] || env_set F451_WEBHOOK_SECRET_FORGEJO "$(secret 16)"
  # Visitor statistics at /stats/ (basic auth; Caddy wants a bcrypt hash).
  [ -n "$(env_get F451_STATS_USER)" ] || env_set F451_STATS_USER "stats"
  if [ -z "$(env_get F451_STATS_PASSWORD)" ]; then
    env_set F451_STATS_PASSWORD "$(secret 12)"
    local hash
    hash=$(docker run --rm caddy:2 caddy hash-password --plaintext "$(env_get F451_STATS_PASSWORD)")
    # Single quotes: the hash contains '$', which compose would interpolate.
    env_set F451_STATS_HASH "'$hash'"
  fi
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

  ensure_user "$READER_USER" DEMO_READER_PASSWORD
  ensure_user "$WRITER_USER" DEMO_WRITER_PASSWORD
  # Shown under the sign-in button (F451_SIGNIN_NOTE; \n = line break).
  env_set F451_SIGNIN_NOTE "Demo accounts\\nRead everything: $READER_USER / $(env_get DEMO_READER_PASSWORD)\\nAlso write in the Playground: $WRITER_USER / $(env_get DEMO_WRITER_PASSWORD)\\nThe demo is reset every night."
}

ensure_user() {  # ensure_user NAME ENV_KEY_FOR_PASSWORD
  local name="$1" key="$2"
  [ -n "$(env_get "$key")" ] || env_set "$key" "$(secret 8)"
  # demo.env is authoritative for the password: create the account, or bring an
  # existing one (e.g. from an interrupted earlier run) in line with it.
  if fapi GET "/users/$name" >/dev/null; then
    compose exec -T -u 1000 forgejo forgejo admin user change-password \
      --username "$name" --password "$(env_get "$key")" --must-change-password=false >/dev/null
  else
    compose exec -T -u 1000 forgejo forgejo admin user create \
      --username "$name" --password "$(env_get "$key")" \
      --email "$name@$GIT_HOST" --must-change-password=false >/dev/null
  fi
  ensure_grant "$name"
}

# Forgejo asks every user once whether f451-demo may access the account, and
# the nightly reset recreates the visitor accounts — so visitors would see that
# consent page every day. This Forgejo version has no "trusted app" switch;
# storing the grant ourselves (the same row Forgejo writes after "Authorize")
# skips it. Only for the two visitor accounts and only for our own OAuth app.
ensure_grant() {  # ensure_grant NAME
  local name="$1" cid
  cid="$(env_get F451_OIDC_CLIENT_ID)"
  [ -n "$cid" ] || return 0
  compose exec -T -u 1000 forgejo sqlite3 /data/gitea/gitea.db \
    "INSERT INTO oauth2_grant (user_id, application_id, counter, scope, nonce, created_unix, updated_unix)
     SELECT u.id, a.id, 1, 'openid email profile', '', strftime('%s','now'), strftime('%s','now')
     FROM user u, oauth2_application a
     WHERE u.lower_name = '$name' AND a.client_id = '$cid'
       AND NOT EXISTS (SELECT 1 FROM oauth2_grant g WHERE g.user_id = u.id AND g.application_id = a.id);"
}

ensure_repos() {
  local id
  for id in $(for s in "${SPACES[@]}"; do echo "${s%%:*}"; done) "$INSTANCE_REPO"; do
    fapi GET "/repos/$ORG/$id" >/dev/null || fapi POST "/orgs/$ORG/repos" \
      "{\"name\":\"$id\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}" >/dev/null
  done
  # "demo" reads all repositories, "writer" reads all and writes the playground
  # (not the instance repository: visitors must not change the instance theme).
  local readers writers
  readers=$(ensure_team readers read true)
  writers=$(ensure_team writers write false)
  fapi PUT "/teams/$readers/members/$READER_USER" >/dev/null
  fapi PUT "/teams/$readers/members/$WRITER_USER" >/dev/null
  fapi PUT "/teams/$writers/repos/$ORG/$WRITABLE_SPACE" >/dev/null
  fapi PUT "/teams/$writers/members/$WRITER_USER" >/dev/null
}

ensure_team() {  # ensure_team NAME PERMISSION ALL_REPOS → prints the team id
  local name="$1" perm="$2" all="$3" id
  id=$(fapi GET "/orgs/$ORG/teams/search?q=$name" | python3 -c "import sys,json;d=[t for t in json.load(sys.stdin)['data'] if t['name']=='$name'];print(d[0]['id'] if d else '')")
  [ -n "$id" ] || id=$(fapi POST "/orgs/$ORG/teams" \
    "{\"name\":\"$name\",\"permission\":\"$perm\",\"units\":[\"repo.code\",\"repo.pulls\"],\"includes_all_repositories\":$all}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "$id"
}

# --- content -----------------------------------------------------------------

# Push demo/<space>/ and deploy/demo/instance/ as the new state of main (only
# if something changed).
seed() {
  say "Content: demo/* and deploy/demo/instance → Forgejo"
  local tmp id token; tmp=$(mktemp -d); token="$(env_get F451_FORGEJO_TOKEN)"
  local base; base="$(forgejo_local | sed "s|http://|http://$ADMIN_USER:$token@|")"
  for s in "${SPACES[@]}"; do
    id="${s%%:*}"
    seed_repo "$id" "demo/$id"
  done
  seed_repo "$INSTANCE_REPO" "deploy/demo/instance"
  rm -rf "$tmp"
}

seed_repo() {  # seed_repo REPO SOURCE_DIR (relative to $REPO); uses $tmp and $base from seed
  local id="$1" src="$2"
  git clone -q "$base/$ORG/$id.git" "$tmp/$id"
  find "$tmp/$id" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -R "$REPO/$src/." "$tmp/$id/"
  if [ -n "$(git -C "$tmp/$id" status --porcelain)" ]; then
    git -C "$tmp/$id" add -A
    git -C "$tmp/$id" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_USER@$GIT_HOST" \
      commit -qm "Demo content from $src ($(git -C "$REPO" rev-parse --short HEAD))"
    git -C "$tmp/$id" push -q origin main
    echo "  ✓ $id"
  else
    echo "  = $id"
  fi
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

# The visitor accounts are shared: anyone signed in could change their
# password, turn on 2FA or add tokens and lock everyone else out. Forgejo can
# forbid deletion and keys (USER_DISABLED_FEATURES), not password or 2FA
# changes — so check that both accounts still sign in with the password from
# demo.env (2FA also makes this fail) and repair an account that doesn't.
# `--force` repairs both (nightly reset).
#
# Repair IN PLACE, never delete and recreate: f451 identifies a person by the
# Forgejo user id (OIDC `sub`), and Forgejo hands freed ids out again — a
# recreated "writer" could get the id "demo" had before, and sessions and
# linked accounts in f451 would point to the wrong person.
guard() {
  local force="${1:-}" name key code
  for pair in "$READER_USER:DEMO_READER_PASSWORD" "$WRITER_USER:DEMO_WRITER_PASSWORD"; do
    name="${pair%%:*}"; key="${pair#*:}"
    code=$(curl -s -o /dev/null -w '%{http_code}' -u "$name:$(env_get "$key")" "$(forgejo_local)/api/v1/user")
    if [ "$code" != 200 ] || [ "$force" = --force ]; then
      echo "  ↻ $name (sign-in check: $code)"
      repair_user "$name"
      ensure_user "$name" "$key"   # password back to demo.env, grant for f451-demo
    fi
  done
  ensure_repos   # team memberships
}

# Remove what a visitor could have added to a shared account: second factors,
# access tokens, keys, extra e-mail addresses, grants for other apps. The
# account itself and its id stay.
repair_user() {  # repair_user NAME
  local name="$1"
  compose exec -T -u 1000 forgejo sqlite3 /data/gitea/gitea.db \
    "DELETE FROM two_factor WHERE uid = (SELECT id FROM user WHERE lower_name = '$name');
     DELETE FROM webauthn_credential WHERE user_id = (SELECT id FROM user WHERE lower_name = '$name');
     DELETE FROM access_token WHERE uid = (SELECT id FROM user WHERE lower_name = '$name');
     DELETE FROM public_key WHERE owner_id = (SELECT id FROM user WHERE lower_name = '$name');
     DELETE FROM gpg_key WHERE owner_id = (SELECT id FROM user WHERE lower_name = '$name');
     DELETE FROM email_address WHERE uid = (SELECT id FROM user WHERE lower_name = '$name') AND is_primary = 0;
     DELETE FROM oauth2_grant WHERE user_id = (SELECT id FROM user WHERE lower_name = '$name')
       AND application_id NOT IN (SELECT id FROM oauth2_application WHERE client_id = '$(env_get F451_OIDC_CLIENT_ID)');" \
    >/dev/null 2>&1 || true
}

reindex() {
  say "Reindex"
  wait_for "$(web_local)/"
  curl -sf -X POST -H "Authorization: Bearer $(env_get F451_ADMIN_TOKEN)" -H 'Content-Type: application/json' \
    -d '{}' "$(web_local)/admin/reindex" | python3 -c '
import sys, json
for r in json.load(sys.stdin):
    rep = r["report"]
    print("  %s: %d pages, %d errors, %d broken links, %d id conflicts" % (
        r["space"], rep["pagesIndexed"], rep["pagesWithErrors"], rep["brokenLinks"], len(rep.get("idConflicts", []))))'
}

# Maintenance page for visitors while containers are replaced (Caddyfile).
maintenance() {  # on | off
  if [ "$1" = on ]; then compose exec -T caddy touch /srv/state/maintenance 2>/dev/null || true
  else compose exec -T caddy rm -f /srv/state/maintenance 2>/dev/null || true; fi
}

deploy() {
  say "Build, migrate, start"
  # Release version for the attribution notice: the latest tag on main, else "dev".
  F451_VERSION="$(git -C "$REPO" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
  export F451_VERSION="${F451_VERSION:-dev}"
  say "Version $F451_VERSION"
  compose build web api mcp
  compose up -d postgres forgejo caddy
  maintenance on
  trap 'maintenance off' EXIT
  # The API discovers the OIDC issuer over HTTPS at start-up; on a fresh
  # server Caddy first has to obtain the certificate.
  wait_for "https://$GIT_HOST/.well-known/openid-configuration"
  compose run --rm api node dist/db/migrate-cli.js
  compose up -d
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true
  wait_for "$(web_local)/"
  maintenance off
  trap - EXIT
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
    printf '\n\033[1;32m✓ Demo: https://%s\033[0m\n  %s / %s (read)\n  %s / %s (write: %s)\n' "$HOST" \
      "$READER_USER" "$(env_get DEMO_READER_PASSWORD)" "$WRITER_USER" "$(env_get DEMO_WRITER_PASSWORD)" "$WRITABLE_SPACE"
    ;;
  update)
    # --tags: the release tag is pushed after its commit; a fetch that already has the
    # commit does not auto-follow the tag, and the attribution notice would say "dev".
    git -C "$REPO" fetch -q --tags origin main
    deployed="$(cat "$(dirname "$DEMO_ENV")/deployed-commit" 2>/dev/null || true)"
    target="$(git -C "$REPO" rev-parse origin/main)"
    if [ "$deployed" = "$target" ] && [ "${2:-}" != "--force" ]; then exit 0; fi
    say "Update ${deployed:0:7} → ${target:0:7}"
    git -C "$REPO" checkout -q main && git -C "$REPO" merge -q --ff-only origin/main
    # Continue with the script version we just pulled, not the one running now.
    exec "$REPO/deploy/demo/demo.sh" apply
    ;;
  apply)
    write_static_config
    setup_forgejo   # idempotent: keeps accounts, OAuth app and sign-in note in line
    ensure_repos
    deploy
    seed
    reindex
    ;;
  guard)
    guard "${2:-}"
    ;;
  reset)
    say "Visitor accounts: repair"
    guard --force
    clear_drafts
    seed
    reindex
    ;;
  stats)
    compose run --rm goaccess >/dev/null 2>&1 || die "goaccess failed"
    ;;
  status)
    compose ps --format 'table {{.Service}}\t{{.Status}}'
    echo "deployed: $(cat "$(dirname "$DEMO_ENV")/deployed-commit" 2>/dev/null || echo -)"
    ;;
  *)
    sed -n '4,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
