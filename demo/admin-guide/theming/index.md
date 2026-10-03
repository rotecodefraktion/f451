---
id: theming
title: "Theming: instance and space themes, templates, brand, contrast thresholds"
description: Giving an instance or a single space its own look — theme files in Git, built-in templates, logo and name, and the contrast thresholds.
tags: [admin, theming, configuration]
lang: en
---

# Theming: instance and space themes, templates, brand, contrast thresholds

A theme changes **token values** — colours, fonts, spacing, radii, shadows,
density. It never changes layout rules or adds CSS. Themes are plain YAML
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

A space repository may carry `_meta/theme.yaml`, `_meta/themes/` and
`_meta/brand/logo.svg` — the same files, minus contrast and favicon.

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
| `--layout-note-w` | 160–320 px |
| `--layout-note-gap`, `--layout-sheet-max` | 0–2 rem, 480–960 px |
| `--control-h` | 44–64 px (upwards only; 44 px is the target-size promise) |

Breakpoints stay fixed. Diagrams keep using the catalog values.

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
**rotecodefraktion**. They cannot be overwritten or deleted. Only the token
values of the original mockups are taken; their layout differences are not.

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

Allowed range is 1.5–7.0 per role; there is no "off". `note` is free text up
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

The api caches the instance theme, space themes, templates, thresholds and
brand files for **5 minutes**. The cache is emptied when a save goes through
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
