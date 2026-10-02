# Changelog

All notable changes to f451. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) — from 1.0.0 on, breaking changes
to the HTTP API, the MCP tools, the page format or the configuration only come
with a new major version.

## [1.1.1] — 2026-10-02

No breaking changes. `implicitVersion` and `implicit` are new optional API fields.

### Fixed

- Existing pages in a versioned space count as version 0.1.0 and their original
  state appears in the version list as the initial version. Nothing is written
  to Git until the first release, which can make the page 0.1.1, 0.2.0 or 1.0.0.
- Review page: section titles use one font and style, and the version box's
  title sits inside the box instead of on its border.

## [1.1.0] — 2026-10-01

No breaking changes. Spaces without a `classification:` block behave as before.

### Added

- **Security classifications** — four classes per page (public, internal,
  confidential, strictly confidential), shown as a chip and, for strictly
  confidential pages, a banner. Each space sets a default and a maximum in
  `_meta/schema.yaml`; the editor select is limited to the space maximum.
  Search hides strictly confidential pages and drops the snippets of
  confidential ones; the graph hides strictly confidential neighbours. API
  tokens carry a classification limit (default: internal). Existing tokens get
  internal by migration, which only matters in spaces that turn classifications
  on.
- **Release archive** — "Freeze as release" in the review and in `release_page`
  creates an immutable copy of the page with its attachments under
  `<page>/_releases/<version>/`. Releases open in a read-only view with
  metadata, are marked in the version list, and the page header links to the
  newest one. AI agents read a release with `read_page(version)` via MCP.
  Requires a versioned space.

### Fixed

- Version and release entries in the page header now look like links.

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

[1.1.1]: https://github.com/rotecodefraktion/f451/releases/tag/v1.1.1
[1.1.0]: https://github.com/rotecodefraktion/f451/releases/tag/v1.1.0
[1.0.0]: https://github.com/rotecodefraktion/f451/releases/tag/v1.0.0
