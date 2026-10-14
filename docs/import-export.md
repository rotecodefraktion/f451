# Import and export

f451 imports from BookStack as drafts with reviews, and exports a space or
subtree to BookStack as a book (see [BookStack export](#bookstack-export)).

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

## BookStack export

### Requirements

- An f451 personal access token (`f451_pat_…`) with **read** scope; the export
  never writes to f451.
- A BookStack API token (token ID and secret) of a user who can create and edit
  content.

### Command

```
pnpm --filter @f451/import-cli start -- export bookstack --space <space> [--page <pageId>] [--book <id>] [--dry-run] [--out <dir>]
```

The environment variables are the same as for the import.

| Option | Meaning |
|---|---|
| `--space <space>` | Source f451 space |
| `--page <pageId>` | Export only this page with its subpages (default: the whole space) |
| `--book <id>` | Export into an existing book instead of creating one |
| `--dry-run` | Do not touch BookStack; write the HTML of each page to `--out` |
| `--out <dir>` | Directory for the report (default: current directory) |

### Mapping

The export root becomes a book (named after the space, or the page title with
`--page`). The space's root page becomes the first page of the book.

| f451 | BookStack |
|---|---|
| Export root | Book |
| Page with children | Chapter; its own content is the chapter's first page |
| Page without children | Page |
| Deeper levels | Flattened into the chapter, with the path as name prefix (`B / C`) |

The order follows f451. Archived pages are skipped together with their
subpages.

### Content

Pages are rendered with the same pipeline as the reading view. GFM alerts become
BookStack callouts (`NOTE` → info, `TIP` → success, `WARNING` and `IMPORTANT` →
warning, `CAUTION` → danger).

Links to exported pages point at BookStack; links to other pages of the space
point at f451. Links that cannot be resolved become plain text and are counted
in the report.

Images go to the BookStack gallery and are de-duplicated by content hash (the
hash is the name prefix). BookStack accepts no SVG, so every SVG is converted
to PNG during the export. A draw.io diagram (`.drawio.svg`) becomes a BookStack
drawing that carries the diagram source and can be edited in BookStack's
draw.io editor; an Excalidraw diagram becomes a plain image. Other files from `_media/` become page attachments, and
links to them point at the attachment.

### Second export

Every created book, chapter and page carries the tags `f451-id` and
`f451-space`. A second export finds them and updates in place, renames
included, instead of duplicating. Pages that carry the tags but no longer exist
in f451 are listed as stale in the report; nothing is ever deleted.

Importing an exported book back into f451 skips its pages: the `f451-id` tag is
recognised as their origin.

### Report

Each run writes `export-report.md` to `--out`: created, updated and failed
pages, stale pages, missing media and the number of broken links.

## From the web UI

Signed-in users can run the BookStack import and export from the space sidebar
("Import / export"), without the command line. The run happens as a job inside
the API; the page shows progress, the page events and the final report
(downloadable as `import-report.md`).

### Enabling

Set `F451_IMPORT_BOOKSTACK_URLS` on the API to a comma-separated list of base
URLs, for example `https://bookstack.example.org`. Only these instances can be
contacted; any other URL is rejected. Unset or empty keeps the feature off and
the sidebar entry hidden. Trailing slashes and the case of the host do not
matter. Redirects to another host are not followed.

### Who may start a job

- **Import** needs write access to the target space, **export** needs read
  access. These are the same Git-provider rights as everywhere else. A space
  that is unknown, not configured or not accessible answers 404.
- The job runs as the user with a short-lived personal access token that is
  revoked when the job ends, so the review workflow, classification and SHA
  contract apply exactly as for the CLI.
- Starting a job needs a browser session; a request with a Bearer token is
  refused (403). Token holders use the CLI.
- A job is visible only to the user who started it.

### BookStack token

The BookStack token ID and secret are entered for each run. They are held in
memory for the duration of the job only and never stored, logged or shown in
the report.

### Behaviour

- One running job per user (a second start answers 409 with the running job's
  id; the page reattaches after a reload) and at most 3 running jobs per API
  process (429).
- Job state lives in API memory. A restart of the API cancels running jobs; a
  new run with "Update earlier imports" continues without duplicates. Finished
  jobs are dropped after 24 hours; the page keeps the last 200 page events.
- Drawings stay PNG (the API container has no Docker or Podman) and are listed
  in the report.
- A dry run writes nothing to f451 (import) or BookStack (export) and produces
  the report only; the generated Markdown is available from the CLI only.

### Cancelling

The owner can cancel a running job. Cancellation is checked before each page,
never in the middle of one, so the job stays `running` until the current page
is finished.

- **Import:** no further pages are created or filled. Pages created but not yet
  filled have their draft discarded, so no empty draft is left behind; they are
  listed in the report under "Cancelled". A later run with "Update earlier
  imports" picks up cleanly.
- **Export:** no further pages are exported. What is already in BookStack stays
  (its pages carry the `f451-id` tag, so the next export updates them); the
  remaining pages are listed under "Cancelled".

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
- Export: the search for stale pages reads at most 100 tagged pages per space.
