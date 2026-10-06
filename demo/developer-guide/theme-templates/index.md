---
id: theme-templates
title: Theme templates
description: How theme templates, switches, cross-token rules and theme stylesheets work in the code, and how to add a built-in template.
tags: [architecture, theming, howto]
lang: en
---

# Theme templates

The operator's view of theming (files, `use:`, settings page) is in the
Admin Guide, page *Theming*. This page is for the code behind it:
`packages/design-tokens` (catalog, resolver, rules, stylesheet check),
`apps/api` (routes, caches) and `apps/web` (settings page, layout).

## Layers and `use`

A theme is resolved token by token and per mode (`resolveTheme` in
`packages/design-tokens/src/theme.ts`) from a **list of layers**:

```
default ← instance ← space ← user
```

Array order is the precedence; a token a later layer leaves out is inherited.
Each layer remembers where a value came from (`origin`: source plus the
template slug if any), which is what the origin marks on the settings page
show.

`use:` never reaches the resolver. The caller turns a template into the
values of its own layer **before** mixing: the file's own values lie on top of
the template's, the result is one layer with `template` set. That is why a
template cannot cycle: **one level deep** is enforced when the file is parsed
(`parseThemeFile(…, { allowUse: false })` for template files), and the
resolver has no loop and no lookup by name. `use: <slug>` names a template of
the layer's own repository, `use: instance/<slug>` one of the instance (only
in a space theme).

## Switches

A switch is a catalog token with `range: { kind: 'choice', values: […] }` and
`emit: 'attribute'`. Two groups, both in `catalog.ts`:

- **Bausteine** (13): how a block is built — `table-style`, `callout-style`,
  `chip-style`, …, and `marginalia` (`margin` | `list`): footnotes as margin
  notes or as an end list. Built-ins: `margin` for Editorial, Fokus and
  Klar & Warm; `list` for System / Raster, Werkbank and Rotecodefraktion.
- **Rahmen** (5): the page frame — `topbar`, `page-head`, `pane-controls`,
  `rail-scroll`, `status-bar`. Several change markup, not only styling.

A switch creates **no CSS variable**. `toAttributes(resolved)` returns a
`data-<name>` attribute for every switch whose value differs from Editorial
(the first value of `values`); `GET /api/theme/resolved` delivers them as
`attributes` (only the deviations) and as `switches` (the full set, which the
Server Components read for the frame); the root layout writes `attributes` on
`<html>`. The settings page's preview carrier does the same on the preview
element.

**Migration.** Files from before 1.2.5 are read in the new form:
`heading-number: counter(sec) '.'` becomes `numeral`, and `heading-number-sub`
becomes `heading-depth`, each with the warning `value_migrated`; the next save
writes the new form.

**Note tokens.** `layout-note-w` (10–20 rem) and `layout-note-gap` (0–2 rem)
were locked from 1.2.5 until margin notes arrived in 1.2.8
([#63](https://github.com/rotecodefraktion/f451/issues/63)); they are
corridor tokens again and only take effect with `marginalia: margin`.

The stylesheets branch on the attribute and follow one pattern: one rule per
value sets **private `--_…` custom properties** on the carrier; the block
reads them with the Editorial value as fallback.

```css
[data-button-primary='accent'] {
  --_btn-p-bg: var(--color-accent);
  --_btn-p-fg: var(--color-accent-contrast);
}
.btn-primary {
  background: var(--_btn-p-bg, var(--color-text));
  color: var(--_btn-p-fg, var(--color-bg));
}
```

The fallback is why a page with no attribute (the default) needs no extra
rule. See `app/styles/40-schaltflaeche.css` and `43-flaeche.css`. Switches
that change markup (the Rahmen group) are read by the Server Components from
the same resolved set, which is why they show after saving and not in the
program preview.

## Cross-token rules: `checkRules`

`checkRules(resolved)` in `packages/design-tokens/src/rules.ts` checks the
**resolved** set, never a single file — a space file that only sets
`--measure-wide` must pass against the `--measure` it inherits. It returns
`RuleViolation[]` (`rule`, `tokens`, `message`, with both tokens and their
layers named). The rules:

| Rule | Meaning |
|---|---|
| `space-monotonic` | the `--space-*` scale does not decrease |
| `weight-gap` | `--weight-strong` at least 100 above `--weight-text` |
| `measure-order` | `--measure` does not exceed `--measure-wide` |
| `pane-controls-needs-topbar` | `--pane-controls: topbar` needs `--topbar: on` |

A value `checkRules` cannot read (`calc()`, `var()`, mixed units) is left
alone. Saving refuses a violation; reading falls back (the pane controls to
`edges`).

## Add a built-in template

Built-in templates are generated, not written by hand.

1. **Mockup.** Add the HTML mockup (or a theme CSS) and a line to `SOURCES` in
   `scripts/themes-from-mockups.ts` (`slug`, `name`, `path`). The script reads
   the token **values** from the file.
2. **`SWITCHES` entry.** Construction cannot be read from values: add the slug
   to `SWITCHES` with **all 18 switches** set explicitly, defaults included
   (so a copy of the template shows every switch). Take shared values from
   `SHARED`; the five frame switches differ per template.
   If the mockup sets the lower `--space-*` steps above the defaults,
   `keepScaleMonotonic` raises the higher ones — check the console output for
   `adjusted` and `dropped` lines.
3. **Generate:**
   `pnpm --filter @f451/design-tokens themes:from-mockups`. It writes
   `packages/design-tokens/themes/<slug>.yaml` and
   `src/builtin-themes.data.ts`. Do not edit either by hand.
4. **Tests** in `packages/design-tokens/test/builtin-themes.test.ts`: add the
   slug to `SLUGS`, and add a line for it to *carries the construction of its
   mockup* and *carries the frame of its mockup*. The per-template tests
   (parses without errors or warnings, contrast check, **passes the
   cross-token rules on the resolved set**, sets every switch) run for it
   automatically. The count of templates is also fixed elsewhere (the
   instance library in the api tests, the settings list); let the test run
   tell you where.

Built-ins cannot be overwritten or deleted through the api; their slugs are
reserved.

## Adopting and saving templates in the settings page

The pure functions live in `apps/web/lib/theme-editor.ts`, so they are testable
without the page:

- `adoptTemplate(draft, template)` replaces the draft's `base`, `light` and
  `dark` values with the template's. `use` stays, so the template remains
  selected; it works for built-in and own templates alike.
- `embedTemplate(draft, template)` merges the template under the draft's own
  values and drops `use` — a template saved from "Fokus plus two colours" really
  contains Fokus.
- `templateFile(draft, name, template)` builds the file for **Save as
  template …**: `embedTemplate` if a template is chosen, then `name`, with no
  `use` and no `brand`.
- `templateState(data, draft, templates)` says what applies, for the select and
  the line below it: the draft's own template, "Own settings (no template)",
  and "Underneath" — template "X" (instance), own settings (instance), or the
  Editorial default, taken from `data.belowLayers`.

## Theme stylesheet

A scope (instance or space) may have `_meta/theme.css` and
`_meta/fonts/*.woff2`. No pointer in `theme.yaml`: file present means active.

- **Check.** `checkStylesheet(text)` in `packages/design-tokens/src/stylesheet.ts`
  is a small tokenizer, not a CSS parser: it skips comments and strings, reads
  every `url(…)` (quoted or not, escapes decoded) and the forbidden keywords.
  It returns `{ ok, problems[] }`, each problem with `code` (`css_import`,
  `css_url`, `css_forbidden`), `line` and `message`. Size (`css_too_large`) and
  empty or non-text bodies (`css_not_text`) are checked by the callers on bytes.
  `rewriteFontUrls(css, base)` points `url(fonts/<name>.woff2)` at the font
  route.
- **Routes** (`apps/api/src/routes/theme-stylesheet.ts`): public GETs
  `/api/theme/stylesheet` and `/api/spaces/:space/theme/stylesheet`
  (`text/css`, `nosniff`, ETag = blob sha, 304) and `…/theme/fonts/:name`; `PUT`
  and `DELETE` on the stylesheet routes commit with the **caller's own provider
  token** and the theme write gates, `422` with `errors[]` on a violation. The
  space GET checks read access itself and answers 404 for no file and no access
  alike; there is no fallback to the instance file.
- **Reading from the repo** (`apps/api/src/theme/stylesheet.ts`): the same
  check; a file that fails is ignored with a log warning, the state tells the
  settings page why. Fonts: name `[a-z0-9-]{1,40}.woff2`, magic bytes `wOF2`,
  1 MB each, 4 MB per repository.
- **Cache and webhook.** `theme/stylesheet-cache.ts` keeps one entry per
  scope for 5 minutes; saving through the api invalidates it, and the push
  webhook (`routes/webhooks.ts`) does when a push touches `_meta/theme.css` or
  `_meta/fonts/`.
- **Layout.** `GET /api/theme/resolved` returns `stylesheets: string[]` — the
  URLs in order (instance, then space, `?v=<sha>` for cache busting), only for
  valid files. The root layout links them after `F451_CUSTOM_STYLESHEET`. The
  query `?ohne-stylesheet` on the appearance page leaves them out for that
  view.

No design check applies to the file: no contrast measurement, no `checkRules`.
