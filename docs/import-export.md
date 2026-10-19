# Import and export

f451 imports from BookStack, from a Markdown folder and from an Obsidian vault
as drafts with reviews, and exports a space or subtree to BookStack as a book
(see [BookStack export](#bookstack-export) and
[File import](#file-import-markdown-folder-and-obsidian-vault)).

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

## File import: Markdown folder and Obsidian vault

Imports a folder of Markdown notes, or an Obsidian vault, from a directory or a
ZIP archive. The same rules as for BookStack apply: drafts and reviews, nothing
is published before release, `--update` finds earlier pages, nothing is ever
deleted.

### Command

```
f451-import markdown <dir|zip> --space <space> [options]
f451-import obsidian <dir|zip> --space <space> [options]
f451-import html <dir|zip> --space <space> [options]
```

A path ending in `.zip` is read as an archive, anything else as a folder.
Only `F451_URL` and `F451_TOKEN` (write scope) are needed. The options are
`--space`, `--parent`, `--update`, `--release`, `--dry-run` and `--out`, with
the meaning given under [BookStack import](#command). Output and exit codes are
the same.

### From the web UI

The import panel has a source switch "BookStack | File". Choose the format
(Markdown folder, Obsidian vault or HTML folder), select a `.zip` file and set the same
options as for BookStack. Progress, cancelling and the review links work as
before. No operator switch is needed: the upload fetches no remote address. The
panel shows the file import even when no BookStack allow-list is set. Anyone
with write access to the space can use it.

The upload is `POST /api/spaces/:space/import/file` (browser session only), a
multipart request with the fields `file` (the ZIP), `format` (`markdown`,
`obsidian` or `html`), `parentId`, `update`, `release` and `dryRun` (`"true"` or
`"false"`). It answers `202 { jobId }`; `400` for a missing field or an archive
that is not accepted (the reason is in the message); `413` when the file is
larger than the limit. `GET /api/import/instances` returns
`fileImport: { maxUploadMb }`. The upload is kept in a temporary file that is
deleted when the job ends, fails or is cancelled.

### Mapping

| Source | f451 |
|---|---|
| Note `A/B.md` | Page "B" below page "A" |
| Folder | Page titled with the folder name |
| Folder note | Content of the folder's page |
| Frontmatter `title` | Page title (else the file name without `.md`) |
| `tags` and inline `#tags` | Page tags |
| Other frontmatter fields | Dropped, counted in the report |
| Image or file referenced by a page | Media of that page (`_media/`); a file used by several pages is copied to each |
| Link to a `.md` file | Link to the imported page |

A folder note is, in this order: `A/A.md`, `A.md` next to `A/`, `A/index.md`,
`A/README.md`. It does not become a page of its own. A folder without one gets
an empty page. Siblings are ordered by title, case-insensitive, folders and
notes mixed. A single top-level folder that wraps the whole archive is removed.

Skipped: `.obsidian/`, `.trash/`, every path segment starting with `.`,
`__MACOSX/` entries, symlinks, `.canvas` files and Excalidraw drawings
(`*.excalidraw.md`, `*.excalidraw`). Canvas files and drawings are listed in
the report.

Each page records its origin as `markdown:<path>`, `obsidian:<path>` or `html:<path>`. A
re-import with `--update` finds pages by it; a renamed file is a new page.

#### Obsidian syntax

Only for `obsidian`:

| Obsidian | f451 |
|---|---|
| `[[Note]]`, `[[Note\|Text]]`, `[[Note#Heading]]` | Internal link |
| `![[image.png]]`, `![[image.png\|300]]` | Image (size dropped) |
| `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]` | Link to the note |
| `![[file.pdf]]` (any non-image) | Link to the file in `_media/` |
| Callout `> [!type]± Title` | GFM alert; the fold marker goes, a custom title becomes a bold first line |
| `==text==` | `**text**` |
| `%%comment%%`, block id `^id` | Removed |
| ` ```dataview ` block | Stays a code block |
| `$…$` math | Stays text |

Links resolve as in Obsidian: a path when the target contains `/`, otherwise a
unique file name. When several notes share the name, the one in the linking
note's folder wins, else the shortest path; the case is reported. A link
without a target stays plain text and is listed as unresolved.

Callout types: NOTE for note, info, abstract, summary, tldr, todo, example,
quote, cite; TIP for tip, hint, success, check, done; IMPORTANT for important,
question, help, faq; WARNING for warning, caution, attention, bug; CAUTION for
danger, error, failure, fail, missing. Unknown types become NOTE.

Inside a table cell, a link with an alias is written `[[id\|text]]`.

Links to a heading currently land at the top of the page
([#163](https://github.com/rotecodefraktion/f451/issues/163)).

### HTML folder

Only for `html`. Every `.html` / `.htm` file is a page; folders become pages as
above. A folder's content comes from `A/index.html`, else `A/index.htm`; there
are no other folder-note forms (`A.html` next to `A/` is an ordinary page). A
root `index.html` is an ordinary top-level page.

| HTML | f451 |
|---|---|
| `<title>` (else first `<h1>`, else file name) | Page title |
| `<main>` (else `<article>`, else `<body>`) | Page content |
| `nav`, `header`, `footer`, `aside`, `script`, `style`, `noscript`, `template`, `form`, `button`, `input`, `select`, `textarea`, `iframe`, `hidden` and `aria-hidden="true"` elements | Dropped, not counted in the report |
| Leading `<h1>` equal to the title | Not duplicated |
| Relative link to an `.html` / `.htm` file (with or without `#anchor`; a `?query` is dropped) | Link to the imported page |
| Link to a folder (`docs/` or `docs/index.html`) | Link to the folder's page |
| Relative image or file, also root-relative (`/img/a.png`) | Media of that page (`_media/`) |
| Absolute URL (`http(s)://…`, `//…`) | Stays as written |
| `<meta name="keywords">` | Ignored, no tags |

The file is read as UTF-8 unless it declares another charset (`<meta charset>`
or `<meta http-equiv="Content-Type">`) that the runtime knows; a file that
cannot be decoded fails alone and the rest continues. The content is converted
with the same HTML converter as the BookStack import (tables, `<details>`, code
blocks); constructs Markdown cannot express are counted as dropped. **Nothing
is fetched**: remote images stay remote images and external links stay links.

A site without `<main>` or `<article>` keeps whatever sits in plain `<div>`s of
the body, navigation included. Notion's HTML export can be imported this way,
with the 32-character ids left in the titles; a dedicated Notion import is
tracked in [#165](https://github.com/rotecodefraktion/f451/issues/165).

### Limits

- The upload is limited to `F451_IMPORT_MAX_UPLOAD_MB` (default 200); larger
  files answer 413.
- An archive is rejected, with a reason, when it has an entry path with `..`, a
  leading `/`, a drive letter or a backslash; duplicate paths; encryption;
  unsupported compression; or is split. It is also rejected as a possible zip
  bomb when it has more than 20,000 entries or unpacks to more than 10 times its
  size or beyond the unpacked-size limit.
- Referenced files missing from the archive are skipped and reported; the
  reference stays as text.
- Dataview results, math rendering, aliases and canvas conversion are not
  supported.

### Report additions

Besides the usual lists, the report names frontmatter fields that were dropped
(with counts), attachments that no page references, wikilinks that could not be
resolved, ambiguous link targets, and skipped canvas and Excalidraw files.

## File import: Office files

Imports Word, PowerPoint and Excel documents, and the LibreOffice equivalents,
as pages. LibreOffice does the conversion in a separate **convert service**; f451
turns its HTML into Markdown. The same rules as for the other file imports apply:
drafts and reviews, nothing is published before release, `--update` finds earlier
pages, nothing is ever deleted.

| Kind | Extensions |
|---|---|
| Text | `.docx` `.doc` `.odt` `.rtf` |
| Slides | `.pptx` `.ppt` `.odp` |
| Sheets | `.xlsx` `.xls` `.ods` |

### Command

```
f451-import office <file|dir|zip> --space <space> [--split] [--convert-url <url>] [options]
```

The source is one Office file, a directory or a ZIP archive. In a directory or
ZIP, folders become pages as for the other file imports; files that are not
Office files are attachments. The options of `markdown` apply. The converter is
the service at `--convert-url` or `F451_CONVERT_URL`; if neither is set, a
`soffice` on the `PATH` does the same work locally.

### From the web UI

The format "Office files" appears in the file import only when the operator
has configured the convert service (`F451_CONVERT_URL`, see
[deploy/BETRIEB.md](../deploy/BETRIEB.md)). The file input takes a `.zip` or a
single Office file, and the checkbox "Split (chapters, slides, sheets)" turns
splitting on. Upload: `POST /api/spaces/:space/import/file` with `format=office`
and, for splitting, `split=1`. Without the service `format=office` answers
`400`, and `GET /api/import/instances` returns `fileImport.office: false`.

### Word options

These apply to text documents (docx, odt, doc, rtf). In the web UI they sit in
the group "Word" under the format; on the command line and in the upload they are
fields of the same names.

| UI | CLI | Upload field | Values (default) |
|---|---|---|---|
| Keep outline numbers | `--no-numbering` | `numbering` | `true`, `false` (`true`) |
| Name of the main page | `--main-name` | `mainName` | `title`, `file`, `id` (`title`) |
| ID pattern | `--id-pattern` | `idPattern` | e.g. `DOC-###`; required with `mainName=id` |
| Display | `--id-display` | `idDisplay` | `id`, `id-title` (`id-title`) |
| Subpage level | `--split-level` | `splitLevel` | `1`–`3` (`1`) |
| Name of the subpages | `--sub-name` | `subName` | `chapter`, `title-chapter`, `key-chapter`, `key-number` (`chapter`) |
| Table of contents | `--no-toc` | `toc` | `true`, `false` (`true`) |
| TOC depth | `--toc-depth` | `tocDepth` | `1`–`3` (`2`) |

- **Main page name.** `title` is the document title (else the file name), `file`
  the file name. With `id` the page is named by the pattern: the run of `#` is a
  counter with that minimum width, so `DOC-###` gives `DOC-001`, and `DOC-1000`
  stays `DOC-1000`. The counter continues after the highest number among the
  titles of the whole target space; files of one run get consecutive numbers in
  the order of their paths. A page imported before keeps its number on
  `--update`, as long as its title still follows the pattern. `id-title` names
  the page `DOC-001 Title`. A pattern without `#` is a fixed ID. Pattern: 1–40
  characters (letters, digits, `-`, `_`, `.`, space and `#`), at most one run of `#`.
- **Subpages** (only with split). `splitLevel` is the heading level that starts a
  subpage; at level 2 or 3 a heading of a lower level gets its own page holding
  the text up to the next heading, so the pages nest. `subName` names them by
  the chapter heading, `Title – Chapter`, `File or ID – Chapter` or
  `File or ID.Number Chapter` (the outline number, else the position).
- **Table of contents** (only with split). The main page gets a list of the
  subpages and sections, down to `tocDepth`, after its introduction.
- Split-only fields without split, `mainName=id` without a pattern, a bad value,
  and any of these fields with another format answer `400` (the CLI refuses
  the call with the same message).

### Mapping

- **One page per file** by default; the title is the document's title property,
  else the file name without extension. With **split**, a text document gets one
  child page per heading 1 (what comes before the first one stays on the file
  page), a presentation one per slide (title of the slide, else "Folie n" / "Slide n"
  in the space language) and a workbook one per sheet. A re-import with `--update`
  matches the parts by position, so inserting a slide shifts the later ones.
- **Slides** are imported as an image plus text (#177): a rendered SVG of the slide
  (`_media/slide-NN.svg`) comes first, below the slide heading or at the top of the
  slide's page when split, then the slide's text and speaker notes. Where no image
  could be rendered, the slide keeps its text only and the report counts it
  (`slideImage`).
- **Charts** (and other drawn objects such as SmartArt) become SVG images; where the
  chart's data can be read, a Markdown table with the values follows the image.
- **Sheets** become tables with the displayed (recalculated) values, not the
  formulas. Empty sheets are skipped; very long sheets are cut and the report says
  so.
- **Images** become page media. **Video and audio** embedded in the file are page
  media too and are listed under the heading "Anhänge" at the end of the page (on
  the slide's page when split).
- Links between Office files of the same ZIP point to the imported pages.

### What is dropped

Macros and everything else the Markdown dialect cannot express (layout, fonts,
colours, animations) are not imported. The report lists what was dropped, with counts. A file that LibreOffice
cannot open (corrupt, password-protected, too slow) is listed as failed; the
other files of the run are still imported.

### The convert service

`apps/convert` wraps a headless LibreOffice behind `POST /convert`. It runs in its
own container on an internal network that only the API can reach, converts one
file at a time, and refuses files above `CONVERT_MAX_MB`. OOXML and ODF files are
ZIP archives; they pass the same entry, ratio and size checks as an uploaded ZIP
before LibreOffice sees them. Settings and memory: see
[deploy/BETRIEB.md](../deploy/BETRIEB.md).

## Office export

Exports a page, or a page with all its subpages as **one** document, as Word
(`docx`), PowerPoint (`pptx`), Excel (`xlsx`) or PDF (`pdf`). The same convert
service as for the Office import does the conversion; without `F451_CONVERT_URL`
the entries are hidden and the routes answer `400` ("export not configured").
Only the **published** version is exported, never drafts or open reviews. Read
access to the space is enough; without access the answer is `404`.

### Formats

- **Word and PDF:** the page title is a heading; with subpages the headings shift
  by the depth below the start page (capped at heading 6). Tables, code blocks,
  lists and images are kept; footnotes become real footnotes. A GFM alert becomes
  a bordered one-cell table. Links to pages inside the export are links within the
  document, links to other wiki pages are absolute URLs. Attachments other than
  images are links, not embedded.
- **PowerPoint:** the start page is the title slide, every `##` section one slide;
  each subpage starts with a section slide. The block `> [!NOTE]` with the first
  paragraph **Speaker notes** becomes the speaker notes. Content that does not fit
  on a slide overflows; the report counts slides with more than 12 lines.
- **Excel:** every GFM table becomes one sheet (named after the nearest heading,
  cut to 31 characters). Numbers, percentages and ISO dates become typed cells;
  anything that only looks like a number (`1.2.3`, `0049 170 1234567`) stays text.
  Without a table the answer is `422` ("no tables to export").

### Triggers

- **Page view:** the button "Export as …" opens a dialog with the format and
  "with subpages"; the download starts at once
  (`GET /api/pages/:id/export?format=docx|pptx|xlsx|pdf&subpages=0|1`).
- **Import/export panel:** the export target "File" runs a background job
  (`POST /api/spaces/:space/export/file` with `{ pageId, format, subpages }`),
  shows progress and, when done, a download link
  (`GET /api/jobs/:id/file`, only for the user who started the job). The file is
  deleted after one hour or on shutdown.
- **Command line:**

  ```
  f451-import export office --space <space> --page <pageId> --format <docx|pptx|xlsx|pdf> [--subpages] [--out <file>]
  ```

  Needs `F451_URL` and `F451_TOKEN`; the file name comes from the response unless
  `--out` is given.
- **MCP:** the tool `export_page` (`page_id`, `format`, `subpages`) returns the
  file as an embedded resource (Base64) up to 20 MB.

### Limits

The instant download stops at 200 pages (`413`) and after 2 minutes (`504`); both
answers point to the panel export, which has no page limit (the convert service's
own timeout still applies, 10 minutes per conversion).

### What is not exported

Drafts, whole spaces (only the subpages of a start page), Mermaid diagrams (they
stay code blocks), templates, a title page and a table of contents. The look is
LibreOffice's default.

## From the web UI

Signed-in users can run the BookStack import and export from the space sidebar
("Import / export"), without the command line. The run happens as a job inside
the API; the page shows progress, the page events and the final report
(downloadable as `import-report.md`).

After an import without release, the pages wait as open reviews in the review
overview of the space (`/wiki/<space>/reviews`), where they can be released
together.

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
