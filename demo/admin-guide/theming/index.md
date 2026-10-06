---
id: theming
title: "Theming: instance and space themes, templates, brand, contrast thresholds"
description: Giving an instance or a single space its own look — theme files in Git, built-in templates, logo and name, and the contrast thresholds.
tags: [admin, theming, configuration]
lang: en
---

# Theming: instance and space themes, templates, brand, contrast thresholds

A theme changes **token values** — colours, fonts, spacing, radii, shadows,
density — and switches between fixed constructions. The theme file itself
never adds CSS rules; an optional [theme stylesheet](#theme-stylesheet) does,
without any design checks. Themes are plain YAML
files in Git, so rights, history and review come from the repository: whoever
may push to the repo may change the theme, and `git log` tells you who
changed the red.

Resolution is token by token, separately for light and dark mode:

```
default ← instance ← space ← user
```

Whatever a level does not set is inherited from the level below. When the
instance theme changes, every space moves with it, except for the tokens a
space set itself. The user level is a personal theme stored with the account
(in the User Guide, page *My settings*); neither the instance nor
a space can forbid it.

## Set up the instance repository

Without an instance repository there is no instance theme: the built-in
default applies, and spaces can still carry their own. Point the api at a
repository with `F451_INSTANCE_CONFIG`:

```
F451_INSTANCE_CONFIG={"provider":"forgejo","owner":"f451","repo":"instance"}
```

It may name the same repository as `F451_GLOBAL_TEMPLATES`; the two
variables are read independently. The provider must also be used by a
space in `F451_SPACES`. See [[configuration-reference]]. "Instance
administrator" is, as everywhere in f451, whoever may push to this repo.

| File in the instance repo | Purpose |
|---|---|
| `_meta/theme.yaml` | The instance theme |
| `_meta/themes/<slug>.yaml` | Instance templates (`slug`: `a–z`, `0–9`, `-`, at most 40 characters) |
| `_meta/contrast.yaml` | Contrast thresholds, instance-wide |
| `_meta/brand/logo.svg`, `_meta/brand/favicon.svg` | Logo and favicon |
| `_meta/theme.css`, `_meta/fonts/*.woff2` | Theme stylesheet and its fonts |

A space repository may carry `_meta/theme.yaml`, `_meta/themes/`,
`_meta/brand/logo.svg`, `_meta/theme.css` and `_meta/fonts/` — the same
files, minus contrast and favicon.

## The theme file

Keys are token names **without** the leading dashes. Structural values go
under `base`, colours and shadows under `light` and `dark`. A theme never has
to be complete; a missing key means "inherit".

```yaml
name: House colours
use: werkbank            # optional template, see below
base:
  font-text: "'Source Serif 4', Georgia, serif"
  density: 1.05
  measure: 70ch
  chip-style: filled      # a building-block switch, see below
light:
  color-accent: '#0b5fa5'
  shadow-md: 0 18px 48px #1c1a171f
dark:
  color-accent: '#7fb7e8'
brand:
  name: Acme Docs
  logo: brand/logo.svg
  favicon: brand/favicon.svg   # instance only
```

Values must match a closed grammar per token type: colours are `#rgb`,
`#rrggbb` or `#rrggbbaa`; fonts are a stack ending in a generic family; no
`url()`, no network fonts. An unknown or locked token is rejected on save and
ignored (with a log warning) on read. A hand-edited file with a bad value
never takes the wiki down: that value is dropped and the inherited one
applies.

Some tokens are locked on purpose, for example the breakpoints, the grid's
computed values and the `--measure-full` width. The ones layout depends on are
settable only inside a **corridor**:

| Token | Corridor |
|---|---|
| `--measure` | 60–80 ch |
| `--measure-wide` | 80–120 ch, and at least `--measure` |
| `--layout-nav-w`, `--layout-rail-w` | 200–360 px |
| `--layout-gutter` | 0.5–3 rem |
| `--layout-sheet-max` | 480–960 px |
| `--control-h` | 44–64 px (upwards only; 44 px is the target-size promise) |
| `--layout-note-w` | 10–20 rem (width of a margin note) |
| `--layout-note-gap` | 0–2 rem (gap between text and margin note) |

The two note tokens were locked from 1.2.5 until margin notes arrived in
1.2.8 ([#63](https://github.com/rotecodefraktion/f451/issues/63)); they only
take effect with `marginalia: margin`.

Breakpoints stay fixed. Diagrams keep using the catalog values.

## Building blocks

Thirteen tokens of the group **Bausteine** switch how a block is built rather
than how it is coloured. They take one of a fixed set of words and never
reach the stylesheet: a value that differs from Editorial becomes a
`data-<name>` attribute on the page root. The defaults are the Editorial
reference design; the construction f451 had before 1.2.5 is the built-in
template **rotecodefraktion** (see below).

| Token | Values (Editorial first) | Block |
|---|---|---|
| `table-style` | `open`, `framed` | table: ink rule under the head, or a framed, rounded box |
| `callout-style` | `bar`, `box` | callout: left bar only, or a framed box |
| `card-top-rule` | `on`, `off` | 2-px ink rule on top of cards and dialogs |
| `button-primary` | `ink`, `accent` | primary button in text colour or in accent |
| `chip-style` | `outline-caps`, `filled`, `marker` | status chip: small caps with outline, filled, or with a square marker |
| `heading-number` | `numeral`, `none` | chapter numerals in the reading view |
| `heading-depth` | `top`, `all` | numerals on h2 only, or also on h3/h4 |
| `toc-style` | `numbered-progress`, `bar` | table of contents numbered with a progress line, or hanging on a bar |
| `tree-guides` | `on`, `off` | guide lines along the page tree's nesting |
| `code-header` | `off`, `on` | a header strip naming the language on code blocks |
| `rail-blocks` | `rules`, `plain`, `cards` | blocks of the info rail separated by hairlines, plain, or as cards |
| `list-marker` | `dash`, `disc` | bullet of unordered lists |
| `marginalia` | `margin`, `list` | footnotes as margin notes next to their paragraph, or as a footnote list at the end of the page |

`marginalia` per built-in template: `margin` for Editorial, Fokus and
Klar & Warm; `list` for System / Raster, Werkbank and Rotecodefraktion. A
footnote with more than one paragraph (or a list or code block) always stays
in the end list, and in a column narrower than 32 rem a margin note sits
below its paragraph.

Files from before 1.2.5 that set `heading-number: counter(sec) '.'` or
`heading-number-sub` are read in the new form with a warning and rewritten on
the next save.

## Frame

Five more choice tokens, in the group **Rahmen**, switch the page frame. They
work like the building blocks (a value that differs from Editorial becomes a
`data-<name>` attribute), but most of them change the **markup**, not only the
styling.

| Token | Values (Editorial first) | Effect |
|---|---|---|
| `topbar` | `off`, `on` | top bar above the page grid |
| `page-head` | `title`, `toolbar` | a title row (h1 from the page's leading `#` heading, else the front matter title; status chip; actions) with a meta line below, or the column title plus toolbar of 1.2.5 |
| `pane-controls` | `edges`, `topbar` | thumb grips on the edges, or switches for the tree and the info rail in the top bar (grips are dropped) |
| `rail-scroll` | `sticky`, `own` | info rail sticks within the document scroll, or scrolls on its own |
| `status-bar` | `off`, `bottom` | a slim line at the foot of the main area: status, last update, section x of y |

**Rule:** `pane-controls: topbar` needs `topbar: on`. Saving a theme that
breaks it is refused with both tokens named; a file that breaks it anyway (say,
edited by hand) is read with the edge grips instead.

Frame switches change markup, so they show **after saving**, not in the
program preview. Pages without a page tree (settings, graph, error pages)
always keep the top bar, whatever `topbar` says — brand, account and search
need a place. Without a top bar, brand, space switcher and search move to the
head of the page tree, language, theme and account to its foot. The phone
layout is the same for every switch.

With `page-head: title`, if the page body starts with a `# heading`, the title
row shows that heading and it is removed from the body; only a page without a
leading `#` heading shows the front matter `title:`. There is never a second h1.

Each template writes all five switches:

| Switch | Editorial (default) | Fokus | Klar & Warm | System / Raster | Werkbank | Rotecodefraktion |
|---|---|---|---|---|---|---|
| `topbar` | off | off | on | off | on | on |
| `page-head` | title | title | title | title | toolbar | toolbar |
| `pane-controls` | edges | edges | topbar | edges | topbar | edges |
| `rail-scroll` | sticky | sticky | sticky | sticky | own | own |
| `status-bar` | off | off | off | off | bottom | off |

`use: rotecodefraktion` keeps the frame of 1.2.5. An instance without a theme
sees the Editorial frame from 1.2.6 on.

## Templates

A template is a theme file in `_meta/themes/`. The active theme selects it
with `use: <slug>` (a template of its own level) or `use: instance/<slug>`
(from the instance repo, the only form in a space theme that points
outside). Values in the file lie on top of the template. A template may not
use another template. Deleting a template that is still referenced is
allowed; the references then apply without one and the settings page shows
"Template not found".

Five templates ship with f451 and appear as built-in in the instance
library: **fokus**, **klar-warm**, **system-raster**, **werkbank** and
**rotecodefraktion**. They cannot be overwritten or deleted. They carry the token values **and** the
building-block switches of their mockups; every built-in sets all thirteen
switches explicitly. **rotecodefraktion** is the construction f451 had before
1.2.5 with the demo theme's colours — `use: rotecodefraktion` plus your own
colours keeps that look.

## Derive your own template from a built-in one

Built-ins cannot be edited, but they can be copied: on the appearance page
choose the scope (instance or space), pick the built-in in **Template**,
press **Adopt template** — the template's base, light and dark values replace
the draft's and the template stays selected (this works for any template,
built-in or your own) — change what you like, then **Save as template …**
with a name and slug. The new file in `_meta/themes/` holds everything the
built-in set, the thirteen switches included, and no `use` and no brand. **Save as
template …** always embeds the chosen template this way, so a template saved
from "Fokus plus two colours" really contains Fokus.

Rotecodefraktion, the demo theme, is exactly such a template: the
construction f451 had before 1.2.5 with its own colours and typefaces.

## Upgrading to 1.2.5–1.2.7

From 1.2.5 on, the default look and, from 1.2.6, the default frame follow the
Editorial mockup: an instance without a theme of its own looks different after
the update (no top bar, new building blocks). To keep the earlier look, put
`use: rotecodefraktion` into `_meta/theme.yaml`, plus your own colours if you
had any. Old values are migrated on read (see *Building blocks*); no manual
step is needed. 1.2.7 adds the theme stylesheet; nothing changes for
repositories without a `_meta/theme.css`.

## Create your own template

A template is one YAML file; there are two ways to get it into `_meta/themes/`.

**Via Git.** Write `_meta/themes/<slug>.yaml` in the instance repo (templates
for every space) or in a space repo (templates for that space). The format is
the theme file above, with `name:` and the values; the slug is `a–z`, `0–9`,
`-`, at most 40 characters. Do not set `use:` — a template may not use another
one. Copy the full set of a built-in template if you want to start from it
(see the previous section). The files `_meta/theme.css` and `_meta/fonts/`
belong to the repository's theme, not to a single template: a template does
not carry them, and `use:` does not pull them in.

**Via the settings page.** Choose the scope (instance or space), pick a
built-in or existing template in **Template**, press **Adopt template**,
adjust values and switches, then **Save as template …** with a name and slug.
The page commits `_meta/themes/<slug>.yaml` with your linked account. The
line under the list, "Underneath: …", tells you what the draft lies on.

**Using a template.** In `_meta/theme.yaml` of the instance or a space:

```yaml
use: house-style            # a template of the same repo
# or, in a space theme:
use: instance/house-style   # a template of the instance repo
```

Your values in the file lie on top of the template. In a space, a theme with
no `use:` inherits from the instance as usual.

**Falling back to the instance.** In a space, **Reset to instance theme**
deletes the space's `_meta/theme.yaml`; the space then shows the instance
theme again. Its own templates stay in `_meta/themes/`.

## Theme stylesheet

For anything tokens and switches cannot express, an instance or a space may
carry its own CSS file. It is the greatest freedom and the least safety net:
**f451 checks no design promises** — no contrast measurement, no frame rules.
Whoever writes the file is responsible for how the pages look.

Put it at `_meta/theme.css` in the instance repo and/or a space repo. There
is no pointer in `theme.yaml`: file present means active. Alternatively use
the **Stylesheet** strip on the appearance page (instance and space scope),
which uploads and removes the file with your linked account. The strip also
shows size, version and the fonts. Personal settings have no stylesheet.

### Fonts

Fonts are WOFF2 files under `_meta/fonts/`, added through Git only. Reference
them relatively from the CSS:

```css
@font-face {
  font-family: 'Haus Serif';
  src: url(fonts/haus-serif-regular.woff2) format('woff2');
  font-display: swap;
}
```

| Limit | Value |
|---|---|
| File name | `[a-z0-9-]{1,40}.woff2` |
| Content | real WOFF2 (starts with `wOF2`), otherwise the font answers 404 and is marked "invalid" |
| Per file | at most 1 MB |
| Per repository | at most 4 MB in total |

When serving, f451 points every `url(fonts/<name>.woff2)` at the font route of
the same scope. An unknown name stays as it is and does not load (404) —
that does not block the rest of the file.

### Rules

| Rule | Code |
|---|---|
| At most 256 KB | `css_too_large` |
| No `@import` | `css_import` |
| `url()` only with `data:` or relative `fonts/<name>.woff2` (no `https://…`, no `/api/…`) | `css_url` |
| None of `expression(`, `behavior:`, `-moz-binding`, `javascript:` (case and CSS escapes ignored) | `css_forbidden` |

An upload that breaks a rule is answered with `422`, each problem with its
code, line and reason; nothing is committed (an empty or non-text body is
`css_not_text`). A file that reached the repo by `git push` anyway is
**ignored on read** with a log warning; the strip shows the codes and lines,
or "too large".

### Order

The `<head>` links, in this order: the operator stylesheet
(`F451_CUSTOM_STYLESHEET`, see `deploy/BETRIEB.md`), then the instance's
`theme.css`, then the space's. Later wins, so a repository can override the
operator's file. A space without its own file shows the instance file only.
The CSP is unchanged: everything is served same-origin from `/api`.

### A broken file

The stylesheet also applies to the appearance page and to the
building-block preview. If a file breaks the page you would use to remove it,
open `/einstellungen/erscheinungsbild?ohne-stylesheet`: the view leaves out
the instance and space stylesheets (the strip links it as "Show without
stylesheet"); the operator stylesheet `F451_CUSTOM_STYLESHEET` stays. Then
press **Remove stylesheet**, or fix the file in Git.

## Contrast thresholds

Every save is checked against the fully resolved set, per mode. Thresholds
depend on the role of a colour pair; the **AA reference** next to each is
fixed:

| Role | Default | AA reference |
|---|---|---|
| `body-text` — text read at length | 4.5:1 | 4.5:1 |
| `ui-text` — short text on a surface (labels, chips) | 3.5:1 | 4.5:1 |
| `non-text` — focus ring, state marks | 3.0:1 | 3.0:1 |
| `incidental` — line numbers | 2.0:1 | 4.5:1 |

For an **instance or space theme**, a pair below its threshold blocks the
save (`400` with a list per token). A pair between threshold and AA is saved
with a permanent warning and appears in the report "Values below AA". For a
**personal theme** there are warnings only.

The defaults are set so that the shipped appearance passes; two of the four
are below AA. To change them, create `_meta/contrast.yaml` in the instance
repo (or use the Appearance page in the "Instance" scope):

```yaml
thresholds:
  body-text: 4.5
  ui-text: 4.5
  non-text: 3.0
  incidental: 3.0
note: Raised after the tints were remixed in Q4.
```

On the appearance page the thresholds block (**Prüfschärfe**) is collapsed by
default; it opens by itself only when thresholds are lowered. Allowed range is
1.5–7.0 per role; there is no "off". `note` is free text up
to 500 characters, shown next to the values as text. Thresholds apply to the
whole instance and cannot be set per space — otherwise the most careless
space would set the standard. Lowering a threshold turns a refused save into
a warning; it does not hide it.

## Logo, favicon and name

`brand.name` replaces "f451" in the header and `<title>`. A space inherits
`name` and `logo` from the instance and may override both; the favicon is
instance-only (browsers cache it per origin). Files must be **SVG**, at most
**256 KB**, and pass the SVG sanitizer; `currentColor` is allowed so the logo
follows the theme. A logo the sanitizer changes is accepted with a note. A
file that is too large or not SVG answers `422` and is not committed. The
"Based on f451 by rotecodefraktion.de" line in the sidebar is part of the
licence and stays regardless of the brand name.

## Caches

The api caches the instance theme, space themes, templates, thresholds,
brand files, theme stylesheets and fonts for **5 minutes**. The cache is emptied when a save goes through
the api, and when a webhook push touches one of the files above — so a change
made directly in Forgejo or GitHub shows up right away if the webhook is
configured (see [[spaces-and-git-providers]]), otherwise after at most five
minutes. A change to `_meta/contrast.yaml` empties the cache for every scope.
Pages carry the theme inline in the document; an already open tab keeps its
look until the next load.

> [!NOTE]
> Personal themes are the one thing stored only in Postgres (table
> `user_settings`). Losing `pg-data` loses them, like sessions; instance and
> space themes are in Git. Users can download their theme as a YAML file.
> See [[backup-and-restore]].
