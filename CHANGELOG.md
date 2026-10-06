# Changelog

All notable changes to f451. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) — from 1.0.0 on, breaking changes
to the HTTP API, the MCP tools, the page format or the configuration only come
with a new major version.

## [1.2.9] — 2026-10-06

No breaking changes to the API, the MCP tools, the page format or the
configuration. Footnotes stay standard GFM.

### Added
- Footnotes in the WYSIWYG editor: a reference is a superscript number, a
  definition a bordered block where it stands in the source. Insert one with
  the slash menu item **Footnote**, the toolbar button, or ⌘⇧F (Ctrl+Shift+F
  on Windows and Linux): the reference gets the next free number and an empty
  definition is appended at the end of the page, with the cursor in it.
- Clicking a reference jumps to its definition; clicking the definition's
  label jumps back to the first reference.

### Changed
- Pages with footnotes open in the visual editor again instead of Markdown
  mode.

### Known limitations
- Labels are not renamed in the WYSIWYG mode; use the Markdown mode for word
  labels such as `[^reboot]`. A deleted reference leaves its definition in
  place, and definitions without references are not rendered on the page.

## [1.2.8] — 2026-10-06

No breaking changes to the API, the MCP tools, the page format or the
configuration. Footnotes stay standard GFM (`Text[^1]` … `[^1]: Note`).

### Added
- Margin notes from footnotes: with the new building-block switch
  `marginalia: margin` (Editorial, Fokus, Klar & Warm) a footnote sits in the
  margin next to the paragraph with its first reference; in a column narrower
  than 32 rem, and on the phone, below that paragraph. The number in the text
  jumps to the note and back.
- `marginalia: list` (System / Raster, Werkbank, Rotecodefraktion): a styled
  footnote list at the end of the page. Footnotes with more than one
  paragraph, a list or a code block always go to this list.

### Changed
- `layout-note-w` (10–20 rem) and `layout-note-gap` (0–2 rem) are settable
  again; they were locked since 1.2.5.

### Fixed
- The review diff shows footnote references as superscript numbers and
  definitions as note blocks.

### Known limitations
- In 1.2.8 the editor opens pages with footnotes in Markdown (source) mode
  only; WYSIWYG support for footnotes was added in 1.2.9.

## [1.2.7] — 2026-10-06

No breaking changes to the API, the MCP tools, the page format or the
configuration.

### Added
- Theme stylesheet: `_meta/theme.css` in the instance repository and in each
  space repository, plus WOFF2 fonts under `_meta/fonts/`. Checked on upload
  and on read (`css_import`, `css_url`, `css_forbidden`, `css_too_large`,
  `css_not_text`); no design checks. Linked after `F451_CUSTOM_STYLESHEET`:
  instance, then space.
- Routes `GET /api/theme/stylesheet`, `GET /api/theme/fonts/:name`, the same
  under `/api/spaces/:space/theme/`, and `PUT`/`DELETE` on the stylesheet.
- Settings page: **Stylesheet** strip for instance and space (upload, remove,
  fonts) and the query `?ohne-stylesheet` to view the page without it.
- `stylesheets` in `GET /api/theme/resolved`.

### Documentation
- Template guides: "Create your own template" and "Theme stylesheet" in the
  Admin Guide, the new developer page *Theme templates*, the appearance pages
  of the User Guide checked against 1.2.6, `deploy/BETRIEB.md` on operator
  versus theme stylesheet.

## [1.2.6] — 2026-10-05

No breaking changes to the API, the MCP tools, the page format or the
configuration. **The default frame changes:** without a theme, f451 now shows
the Editorial frame (no top bar, a title row instead of the toolbar, an info
rail as tall as its content). The frame of 1.2.5 lives on in the built-in
template `rotecodefraktion` — `use: rotecodefraktion` keeps it.

### Added
- Group **Rahmen** with five choice tokens (`topbar`, `page-head`,
  `pane-controls`, `rail-scroll`, `status-bar`); the five built-in templates
  set all five explicitly.
- Filter field in the page tree ("Filter pages"; Escape clears).
- Bottom status bar (`status-bar: bottom`).
- `switches` in `GET /api/theme/resolved`.

## [1.2.5] — 2026-10-05

No breaking changes to the API, the MCP tools, the page format or the
configuration. **The default look changes:** without a theme, f451 now shows
the Editorial reference design (open tables, card top rules, dash list
markers, numbered table of contents, tree guide lines, hairlines between rail
blocks). The construction of 1.2.0 lives on as the built-in template
`rotecodefraktion` — `use: rotecodefraktion` in `_meta/theme.yaml` plus your
own colours keeps it.

### Added
- Group **Bausteine** with twelve choice tokens (`table-style`,
  `callout-style`, `card-top-rule`, `button-primary`, `chip-style`,
  `heading-number`, `heading-depth`, `toc-style`, `tree-guides`,
  `code-header`, `rail-blocks`, `list-marker`); deviations from Editorial are
  rendered as `data-<name>` attributes on `<html>` (`GET /api/theme/resolved`
  → `attributes`), never as custom properties.
- The five built-in templates carry the construction of their mockups and set
  all twelve switches explicitly.
- Settings page: **Adopt template** replaces the draft with the chosen
  template; **Save as template …** embeds the chosen template instead of dropping
  it; translated labels for switch values.
- Code blocks carry `data-lang`; `code-header: on` shows the language.

### Changed
- `heading-number` is a switch (`numeral` | `none`); `heading-number-sub` is
  replaced by `heading-depth` (`top` | `all`). Old files are read in the new
  form with a `value_migrated` warning and rewritten on save.
- Ending the program preview reloads the page (switch attributes cannot be
  restored client-side).
- `layout-note-w` and `layout-note-gap` are locked until margin notes exist
  (#63); they had no effect since 1.2.0.

## [1.2.0] — 2026-10-03

No breaking changes. Without `F451_INSTANCE_CONFIG` and without theme files,
the appearance is unchanged.

### Added

- **Themes per instance and space** — `_meta/theme.yaml` in the instance repo
  (new env `F451_INSTANCE_CONFIG`) and in each space repo. Token values are
  resolved per token and per mode, validated against a closed grammar and
  delivered inline in the page head. Rights, history and review come from Git.
- **Personal theme** — "My settings" stored with the account (migration
  0013, table `user_settings`), applied on top of instance and space in every
  space. Download and upload as YAML in the `_meta/theme.yaml` format;
  adjustments from the old browser-only preview can be taken over once.
- **Templates** — `_meta/themes/<slug>.yaml` per instance and space,
  selected with `use`, and five built-in ones: fokus, klar-warm,
  system-raster, werkbank, rotecodefraktion.
- **Corridors** — `--measure`, `--measure-wide`, grid widths and
  `--control-h` are settable within fixed ranges; breakpoints stay fixed.
- **Brand** — name, logo and favicon per instance, name and logo per space
  (SVG only, 256 KB).
- **Contrast thresholds** — per role, set instance-wide in
  `_meta/contrast.yaml` (1.5–7.0) against a fixed AA reference. Below the
  threshold blocks saving an instance or space theme; personal themes only
  get warnings.
- **Appearance settings page** — `/einstellungen/erscheinungsbild` with the
  scopes My settings, Instance and each writable space, origin marks,
  template picker, contrast feedback and a phone layout.
- **API** — `/api/theme`, `/api/spaces/:space/theme`, `/api/me/theme`,
  `/api/theme/resolved`, `/api/theme/scopes`, `/api/theme/editor`,
  `/api/theme/contrast`, the template library routes and the brand routes.

## [1.1.1] — 2026-10-02

No breaking changes. `implicitVersion` and `implicit` are new optional API fields.

### Fixed

- Versions in a versioned space: 1.0.0 is a release the reviewer chooses, not
  automatic. A new page's first release offers 0.1.0 (default) or 1.0.0; until
  now it always became 1.0.0. A page that already existed when versioning was
  turned on counts as 0.1.0, its first release offers 0.1.1, 0.2.0 or 1.0.0,
  and its original state appears in the version list as the initial version.
  Drafts have no version; nothing is written to Git until a release.
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

[1.2.0]: https://github.com/rotecodefraktion/f451/releases/tag/v1.2.0
[1.1.1]: https://github.com/rotecodefraktion/f451/releases/tag/v1.1.1
[1.1.0]: https://github.com/rotecodefraktion/f451/releases/tag/v1.1.0
[1.0.0]: https://github.com/rotecodefraktion/f451/releases/tag/v1.0.0
