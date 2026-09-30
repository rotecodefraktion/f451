# Changelog

All notable changes to f451. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) — from 1.0.0 on, breaking changes
to the HTTP API, the MCP tools, the page format or the configuration only come
with a new major version.

## [1.0.0] — 2026-09-30

First release. f451 is a wiki for documentation that lives in Git:
every space is a repository on Forgejo or GitHub, every page a Markdown file,
every change a draft, a review and a release.

### Features

- **Git as the source of truth** — spaces are repositories, pages Markdown files
  with front matter; the database is only an index and can be rebuilt from Git.
- **Reading** — page tree, full-text search, table of contents, broken-link
  report, knowledge graph; light and dark mode; German and English interface;
  phone layout.
- **Writing** — WYSIWYG and raw Markdown editor with autosave and local buffer,
  visible conflicts instead of silent overwrites, templates, metadata schema per
  space, draw.io and Excalidraw diagrams editable inside the page, YouTube.
- **Review instead of direct writes** — draft (branch) → review (pull request)
  → release (merge), for people and AI agents alike; visual diff; optional page
  versioning with change notes.
- **Permissions from the Git provider** — no role system of its own; writes use
  the author's own Git account.
- **Sign-in** — any OpenID Connect provider (Microsoft Entra ID, Forgejo,
  Keycloak, …) with a configurable button label, one-step sign-in and linking
  with Forgejo, GitHub sign-in; e-mail fallback for Entra ID.
- **AI agents** — MCP service with personal API tokens: read, search, write
  drafts, generate diagrams, request reviews.
- **Look** — design tokens, operator stylesheet (`F451_CUSTOM_STYLESHEET`),
  self-hosted typefaces, the f451 mark and favicon.
- **Operations** — Docker Compose stacks for Forgejo and the app, configurable
  ports and cookie prefix for several instances on one host, reindex and drift
  reconciliation, graceful API shutdown, a reproducible public demo
  (`deploy/demo/`) with nightly reset and automatic deploys.
- **Container images** — `ghcr.io/rotecodefraktion/f451-web`, `-api`, `-mcp`,
  built on every release tag.

### Fixed since the first public snapshot

- A page id used in a second space no longer moves the page between spaces;
  the conflict is reported by the reindex (#7).
- Callout titles and the YouTube label follow the interface language (#9).
- No review or release for a draft without changes (#11).
- Discarding a draft that no longer exists leaves the editor instead of asking
  to retry (#22).
- Requests are no longer lost while containers are replaced; no orphan draft
  branches after an interrupted page creation.

### License

f451 License 1.1 — PolyForm Shield 1.0.0 with additional conditions: free to
use, change and share, also commercially; a separate license is needed only to
sell f451 or offer it as a paid hosted service. See `LICENSE.md`.

[1.0.0]: https://github.com/rotecodefraktion/f451/releases/tag/v1.0.0
