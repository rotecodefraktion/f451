# Public demo instance

Runs f451 with the clean content from [`demo/`](../../demo) on one server:
Forgejo, the app and Caddy (TLS via Let's Encrypt) in a single Compose
project. New commits on `main` are deployed automatically, and the demo resets
itself every night.

```
Internet ──443──▶ Caddy ─┬─ <F451_DEMO_HOST>      → web (app, proxies /api /auth /media /drawio /mcp)
                         └─ <F451_DEMO_GIT_HOST>  → Forgejo (sign-in + repositories)
```

Spaces: **User Guide**, **Developer Guide**, **Admin Guide** and
**Playground**. Two visitor accounts in Forgejo: `demo` reads every space,
`writer` may also write in the Playground. Registration is disabled.

## Requirements

- A Linux server with Docker Engine and the Compose plugin, `git`, `python3`,
  `openssl`, `curl`. 4 GB RAM is tight for building the web image; 8 GB is
  comfortable.
- Ports 80 and 443 open; everything else closed. The app containers publish
  their ports on `127.0.0.1` only.
- Two DNS names pointing at the server, e.g. `demo.example.org` and
  `git.demo.example.org`.

## Setup

```sh
# as root
useradd -m -s /bin/bash -G docker f451
install -d -o f451 -g f451 -m 750 /opt/f451-demo
sudo -u f451 git clone https://github.com/rotecodefraktion/f451.git /opt/f451-demo/repo
sudo -u f451 install -m 600 /dev/null /opt/f451-demo/demo.env
cat >> /opt/f451-demo/demo.env <<EOF
F451_DEMO_HOST=demo.example.org
F451_DEMO_GIT_HOST=git.demo.example.org
EOF

sudo -u f451 DEMO_ENV=/opt/f451-demo/demo.env /opt/f451-demo/repo/deploy/demo/demo.sh setup

cp /opt/f451-demo/repo/deploy/demo/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now f451-demo-update.timer f451-demo-reset.timer f451-demo-stats.timer f451-demo-guard.timer f451-demo-watch.timer
```

`setup` writes all secrets into `demo.env` (Forgejo admin, service token,
OAuth app, token key, visitor passwords) and prints both visitor logins.

Besides the spaces, `setup` and `apply` create an instance repository
`f451/instance`. Its `_meta/theme.yaml` (pushed from `deploy/demo/instance/`)
selects the built-in template `rotecodefraktion`, so the demo keeps the look of
f451 before 1.2.5. Visitors can read it but not write it, and the nightly reset
restores it together with the spaces.

Set `F451_IMPRINT_URL` and `F451_PRIVACY_URL` in `demo.env` for a public
instance: the app shows them next to the attribution notice, Forgejo in its
footer. The privacy policy should cover the access log and statistics below —
`legal/privacy.html` is the one of the public demo, served at `/privacy`
(replace it with your own when you run a demo).

## Operation

| Command | What it does |
|---|---|
| `demo.sh update` | Runs every 5 min (timer). Does nothing unless `origin/main` moved; then pulls, builds, migrates, restarts, pushes `demo/*` into the spaces and reindexes. `--force` redeploys the current commit. |
| `demo.sh reset` | Runs nightly at 03:30 (timer). Repairs the visitor accounts (password, no 2FA/tokens/keys), closes open reviews, deletes draft branches, restores all spaces to `demo/*`, reindexes. |
| `demo.sh guard` | Runs every 5 min (timer). The visitor accounts are shared; if one no longer signs in with the password from `demo.env` (changed password, 2FA turned on), it is repaired in place — never deleted, because f451 identifies people by the Forgejo user id and Forgejo reuses freed ids. |
| `demo.sh watch` | Runs every 5 min (timer), skipped while an update or reset runs. Restarts containers whose health check fails (the API's checks the database via `/readyz`) and warns once a day while the root disk is at or above `F451_DISK_ALERT_PERCENT` (default 80). Messages go to the journal and, with `F451_NTFY_TOPIC` set in `demo.env`, as a push message via [ntfy](https://ntfy.sh) (`F451_NTFY_URL` for a server of your own). |
| `demo.sh status` | Container status and the deployed commit. |

The Git side gets the same colours, typefaces and mark as the app
(`forgejo/`, see the README there).

While a deploy replaces the containers, Caddy shows a "rebuilding" page
(`maintenance/index.html`, HTTP 503, reloads itself; config in `caddy/Caddyfile`) — `demo.sh` switches it on
and off via a flag file in the `maintenance-state` volume. Requests that hit a
container while it is starting are held for up to 60 s instead of failing.

**Visitor statistics** at `https://<F451_DEMO_HOST>/stats/` (user `stats`,
password `F451_STATS_PASSWORD` in `demo.env`): GoAccess reads Caddy's access
log every 10 minutes (`f451-demo-stats.timer`) and keeps its counts in the
`goaccess-db` volume, so they survive log rotation, deploys and the nightly
reset. IP addresses are shortened to /24 (IPv4) and /48 (IPv6) before they are
written, cookies and credentials are dropped — unique visitors are therefore
an estimate.

Logs: `journalctl -u f451-demo-update -u f451-demo-reset -u f451-demo-stats -u f451-demo-watch`.

**Hardening.** Caddy sends HSTS (one year, no preload), `X-Content-Type-Options`
and `Referrer-Policy` for both hosts; the app sets its own Content-Security-Policy,
Forgejo's host only forbids framing by other sites. Request bodies are capped at
12 MB, matching the API's upload limit (`F451_MAX_UPLOAD_MB`, default 10) and
Forgejo's attachment limit of 10 MB.

Nothing here needs a backup or a snapshot before updates: the demo is rebuilt from this repository.
`demo.env` is the only state worth keeping (it holds the OAuth app and
accounts); losing it means running `setup` on fresh volumes.
