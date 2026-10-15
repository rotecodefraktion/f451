<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
    <img src="docs/brand/lockup.svg" alt="f451 — Documents without handcuffs." width="420">
  </picture>
</p>

# f451

**Documents without handcuffs.** A wiki for documentation that lives in Git.

f451 combines the comfort of a wiki — page tree, search, editor, approvals —
with Git as the single source of truth. Every page is a Markdown file in a
repository on Forgejo or GitHub. Who may read and who may approve is decided by
the repository, not by a second permission system. And every change goes, like
code, through a draft and a review before it is published.

f451 is built for operations, process and project documentation that has to be
traceable, reviewable and durable — and that people can still maintain without
knowing Git.

## Why f451

There are plenty of wikis and documentation platforms. f451 is built around a
few requirements that most of them don't meet together:

- **An open, portable format.** Pages are plain Markdown — no proprietary
  extensions outside the standard. Your documentation is never locked into a
  vendor, the way it is with SharePoint or, in parts, Confluence.
- **Open to AI agents.** Any agent can connect through the built-in MCP server,
  and because pages are plain Markdown, agents read and write them as easily
  as people do.
- **Permissions and approval from day one.** Access follows the repository;
  every change goes through draft, review and release. Version control is not
  an add-on — it is Git.
- **Data sovereignty.** The documents live in your repositories. When someone
  leaves, there are no synced local copies scattered across laptops to worry
  about.

## Live demo

**https://f451.rotecodefraktion.de** — sign in with Forgejo:

| Account | Password | May |
|---|---|---|
| `demo` | `da9d33b2efdb41ed` | read every space |
| `writer` | `43dc099d5da028f4` | also write in the Playground |

The demo is reset every night. It contains the f451 documentation itself: a
**User Guide** (reading, writing, reviews, the editor, AI agents), a
**Developer Guide** (architecture, local setup, extending f451) and an
**Admin Guide** (sign-in options such as Entra ID, configuration, operations) —
the same content as [`demo/`](demo/) in this repository.

## What f451 does

**Git as the source of truth**
- Every *space* is a repository (Forgejo or GitHub), every page a Markdown file
  with YAML front matter.
- The database is only an index — if it is lost, it is rebuilt from Git.
- The history of a page is its Git history.

**Reading**
- Page tree, full-text search (⌘K), table of contents, report of broken links
- Knowledge graph: pages, hierarchy, links and relations as a graph
- Light and dark mode, German and English interface, usable on phones and tablets

**Writing**
- WYSIWYG editor and raw Markdown mode, autosave, local buffer when the
  connection drops
- No silent overwrites: conflicts are shown, never discarded
- Templates and a metadata schema per space
- Diagrams with draw.io and Excalidraw, editable right inside the page
- Import from and export to BookStack (import as drafts with reviews) — see [`docs/import-export.md`](docs/import-export.md)

**Review instead of direct writes**
- Draft → review → release: a draft is a branch, a review a pull request, the
  release a merge — for people and agents alike.
- Visual comparison of the change before release
- Versioning per page (version number and change note), with comparison
  between versions

**Permissions from the Git provider**
- No role system of its own: visibility and write access follow the
  repository's permissions.
- Whoever writes, writes under their own account — never under a service account.

**AI agents**
- An MCP service gives agents access: read, search, write drafts, generate
  diagrams — with a personal API token and through the same review path as
  people.

**Customizable**
- The look is built on design tokens; colors, type and spacing are set through
  a catalog.

## Architecture

```
Browser ──► web (Next.js) ──► api (Fastify) ──► Forgejo / GitHub   (content, permissions)
                               │           └──► PostgreSQL        (index, sessions)
AI agent ──► mcp ──────────────┘
```

| Part | Role |
|---|---|
| `apps/api` | Indexing, read and write endpoints, review workflow, permission checks, webhooks |
| `apps/web` | User interface; forwards `/api`, `/auth`, `/media` to the API |
| `apps/mcp` | Access for AI agents, a stateless translator between MCP and the HTTP API |
| `packages/markdown` | Markdown processing, shared by reading and writing |
| `packages/editor` | Editor core (ProseMirror/Tiptap) |
| `packages/design-tokens` | Token catalog for the look and feel |
| `packages/git-provider` | Connection to Forgejo and GitHub |

Sign-in uses OpenID Connect — with Microsoft Entra, Forgejo or any other OIDC
provider.

## Quick start (local, with Docker)

Requirements: Docker (or Podman) and Node 22 with pnpm 9.

1. **Pick an address.** The browser and the containers must reach Forgejo and
   the wiki under the same address. `localhost` does not work, because inside a
   container `localhost` is the container itself. Use your machine's LAN
   address, called `<IP>` below.
2. **Start Forgejo** (provides sign-in and content):
   ```
   cat > deploy/git/docker-compose.override.yml <<EOF
   services:
     forgejo:
       environment:
         FORGEJO__server__ROOT_URL: http://<IP>:3300/
   EOF
   docker compose -f deploy/git/docker-compose.yml up -d
   ```
3. **Set up** — creates an admin, an organization, an OAuth app and a demo
   space, and writes `deploy/wiki/.env`:
   ```
   FORGEJO_URL=http://<IP>:3300 WEB_BASE=http://<IP>:8080 ./scripts/dev-local-setup.sh
   ```
4. **Start the wiki:**
   ```
   cd deploy/wiki && docker compose up -d --build
   ```
5. **Open** `http://<IP>:8080`, sign in through Forgejo (`wiki-admin` /
   `admin1234`), then link your Forgejo account under *Settings → Connections*
   — only then do the spaces become visible and writable.

Database migrations do not run automatically; after an update run
`docker compose run --rm api node dist/db/migrate-cli.js`.

This setup is meant for local development only (HTTP, insecure cookies). For
production, see below.

## Container images

Every release publishes the images `ghcr.io/rotecodefraktion/f451-web`,
`f451-api` and `f451-mcp` (tags `1.0.0`, `1.0`, `latest`). To run a release
without building, use `deploy/wiki/docker-compose.registry.yml` with
`F451_REGISTRY=ghcr.io/rotecodefraktion` and `F451_TAG=1.0.0`. Changes are
listed in [`CHANGELOG.md`](CHANGELOG.md).

## Operations

Architecture, all environment variables, backup and restore, incident playbook
and monitoring: [`deploy/BETRIEB.md`](deploy/BETRIEB.md) (German). In short: the
only thing you cannot lose is the Git repository — the database can always be
rebuilt from it.

## Development

```
pnpm install
pnpm -w typecheck          # types across all packages
pnpm -w test               # all tests (need a container runtime)
pnpm --filter @f451/web test -- lib/urls.test.ts   # a single test file
```

f451 started as a German-language project. Most existing code comments, design
documents and the operations guide are in German; new code, comments, commits
and documentation are written in English, and existing German text is
translated as it is touched. How f451 came about:
[`docs/entwicklungschronik.md`](docs/entwicklungschronik.md).

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

f451 is source-available, not Open Source in the OSI sense. Anyone — companies
included — may use, change and share it for free, run it for their own
documentation, offer paid services around it, and build it into other
products. A separate license is needed only to **sell** f451 or a changed
version, or to offer it as a **paid hosted service**. Credit is required in the
code and in the user interface of every installation ("Based on f451 by
www.rotecodefraktion.de" — f451 shows this notice itself). Excluded are the AfD
and the organizations and platforms named in the license. The license
(PolyForm Shield 1.0.0 plus additional conditions) covers code, documentation
and design alike; details in [`LICENSE.md`](LICENSE.md).
