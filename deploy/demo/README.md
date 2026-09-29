# Public demo instance

Runs f451 with the clean content from [`demo/`](../../demo) on one server:
Forgejo, the app and Caddy (TLS via Let's Encrypt) in a single Compose
project. New commits on `main` are deployed automatically, and the demo resets
itself every night.

```
Internet ──443──▶ Caddy ─┬─ <F451_DEMO_HOST>      → web (app, proxies /api /auth /media /drawio /mcp)
                         └─ <F451_DEMO_GIT_HOST>  → Forgejo (sign-in + repositories)
```

Spaces: **User Guide**, **Developer Guide**, **Admin Guide** (read-only for
visitors) and **Playground** (visitors may write). Visitors sign in with the
Forgejo account `demo`; registration is disabled.

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
systemctl enable --now f451-demo-update.timer f451-demo-reset.timer
```

`setup` writes all secrets into `demo.env` (Forgejo admin, service token,
OAuth app, token key, visitor password) and prints the visitor login.

## Operation

| Command | What it does |
|---|---|
| `demo.sh update` | Runs every 5 min (timer). Does nothing unless `origin/main` moved; then pulls, builds, migrates, restarts, pushes `demo/*` into the spaces and reindexes. `--force` redeploys the current commit. |
| `demo.sh reset` | Runs nightly at 03:30 (timer). Closes open reviews, deletes draft branches, restores all spaces to `demo/*`, reindexes. |
| `demo.sh status` | Container status and the deployed commit. |

Logs: `journalctl -u f451-demo-update -u f451-demo-reset`.

Nothing here needs a backup: the demo is rebuilt from this repository.
`demo.env` is the only state worth keeping (it holds the OAuth app and
accounts); losing it means running `setup` on fresh volumes.
