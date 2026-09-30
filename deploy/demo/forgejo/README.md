# Forgejo look of the demo

Forgejo reads a custom directory (`GITEA_CUSTOM=/data/gitea` in the image).
`docker-compose.demo.yml` mounts these folders into it:

- `public/assets/css/theme-f451.css` — the app's colours and typefaces on top
  of Forgejo's auto theme; selected with `FORGEJO__ui__DEFAULT_THEME=f451`.
- `public/assets/css/f451-fonts.css` — `@font-face` for the self-hosted fonts
  in `public/assets/fonts/` (a copy of `deploy/demo/theme/webfonts`: Docker
  cannot create a mount point inside a read-only bind mount).
- `public/assets/img/logo.svg`, `favicon.svg` — the f451 mark.
- `templates/custom/header.tmpl` — loads fonts and favicon.
- `templates/custom/footer.tmpl` — legal links (`/imprint`, `/privacy`, redirected by Caddy).

Templates are read at start; a change needs a Forgejo restart.
