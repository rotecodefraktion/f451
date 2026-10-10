# Import and export

## What an import does

An import never writes to the published version. For every source page it
creates a **draft** and opens a **review** (one pull request per page); nothing
is visible in the space until someone releases the review — or you pass
`--release`. Page ids are assigned by the API.

Every imported page carries an origin field in its front matter:

```yaml
source:
  type: bookstack
  id: "42"
  url: https://bookstack.example.com/books/handbook/page/intro
```

The field is how a second import recognises its own pages.

## BookStack import

### Requirements

- An f451 personal access token (`f451_pat_…`) with **write** scope, from a
  user who has a connected Git account (writes happen under that account).
- A BookStack API token (token ID and secret) of a user who can read the
  content to import.

### Command

```
pnpm --filter @f451/import-cli start -- bookstack --book <id|slug> --space <space>
```

Environment:

| Variable | Meaning |
|---|---|
| `F451_URL` | Base URL of the f451 instance |
| `F451_TOKEN` | Personal access token (`f451_pat_…`, write scope) |
| `BOOKSTACK_URL` | Base URL of the BookStack instance |
| `BOOKSTACK_TOKEN_ID` | BookStack API token ID |
| `BOOKSTACK_TOKEN_SECRET` | BookStack API token secret |

Options (exactly one of `--book`, `--shelf`, `--page`, plus `--space`):

| Option | Meaning |
|---|---|
| `--book <id\|slug>` | Import one book |
| `--shelf <id\|slug>` | Import one shelf with its books |
| `--page <id>` | Import one page (numeric id only) |
| `--space <space>` | Target f451 space |
| `--parent <pageId>` | Put the imported tree below this page |
| `--update` | Update pages imported earlier (see below) |
| `--release` | Release the reviews after creating them |
| `--dry-run` | Write nothing to f451; save the generated Markdown to `--out` |
| `--out <dir>` | Directory for the report (default: current directory) |

Exit codes: `0` all pages ok, `1` some pages failed, `2` usage or run-level
error.

### Mapping

| BookStack | f451 |
|---|---|
| Shelf | Folder page with the books below it |
| Book | Folder page |
| Chapter | Folder page |
| Page | Page |

Tags become page tags (`name` or `name:value`). Callouts become GFM alerts
(`info` → `[!NOTE]`, `success` → `[!TIP]`, `warning` → `[!WARNING]`, `danger`
→ `[!CAUTION]`). `<details>` blocks become a `> [!NOTE]` with the summary in
bold. Links between imported pages become wikilinks. Images are downloaded and
uploaded as page media.

Tables: cells with `colspan`/`rowspan` are expanded into empty cells, and
lists or code inside cells are flattened to one line. Both are counted in the
report.

Drawings: draw.io drawings become editable `.drawio.svg` files. Rendering
needs Docker or Podman (`rlespinasse/drawio-desktop-headless`); without one,
the PNG is imported instead and listed in the report.

Images in shelf, book and chapter descriptions are not downloaded; they stay
links to BookStack.

### Report

Each run writes `import-report.md` to `--out`. It lists created, updated,
skipped and failed pages (with reasons), media that were skipped, drawings kept
as PNG, and content that has no Markdown equivalent (HTML elements, merged table cells, block content in cells). With `--dry-run`,
the generated Markdown files are written next to it.

## Second import

With `--update`, pages whose `source:` matches are updated through a new
review. The update replaces the body and the tags; everything else f451 keeps
in the front matter (id, classification, metadata, version) stays. Pages
without `--update` are skipped. A page whose draft is already
open is skipped and reported, never overwritten. Nothing is ever deleted: pages
removed in BookStack stay in f451.

## Limits

- One pull request per page.
- The order of children is applied only with `--release`: the order file lives
  on the published version.
- Drawings without a container stay PNG.
- Media over 10 MiB (`F451_MAX_UPLOAD_MB`) are skipped and reported.
- HTML without a Markdown equivalent is dropped and counted in the report.
