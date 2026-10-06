---
id: instance-and-space
title: Instance and space themes
description: The other theme scopes, who may write them, templates, and the brand (name, logo, favicon).
tags: [guide, settings, theming]
lang: en
---

# Instance and space themes

Besides **My settings** ([[my-settings]]), the **Scope** list offers:

- **Instance** — the look of the whole installation.
- **Space: …** — one entry for each space your linked account may write
  to. A space you can only read is listed as read only.

A value that is not set is inherited: space from instance, instance from
the default. Your personal theme still wins over both.

## Who may write

Instance and space themes are files in their repositories
(`_meta/theme.yaml`). Saving there writes with your linked account and
needs **push right** on that repository. Without it the scope is read
only. **Remove theme** deletes the theme file of the instance; in a space
the button reads **Reset to instance theme** and deletes the space's
`_meta/theme.yaml`, so the space shows the instance's look again. A note
on the page tells you when the space has a theme of its own.
For an instance or space theme, a colour below the contrast threshold
blocks saving; see [[contrast]].

## Templates

The **Template** list above the table starts you from a ready-made set:
the five built-in ones (fokus, klar-warm, system-raster, werkbank,
rotecodefraktion), those of the instance, and in a space those of the
space. Your own values lie on top of the template. The list always shows
what applies: the selected template or "Own settings (no template)", and a
line "Underneath: …" names what your draft lies on — template "X"
(instance), own settings (instance), or the Editorial default.

To start from a template and change it:

1. Choose the template in the **Template** list.
2. Press **Adopt template**. It replaces the draft's base, light and dark
   values with the template's and **keeps the template selected**; this
   works for any template, built-in or your own.
3. Change values row by row, then **Save**.

To keep your result as a template of its own:

1. Choose the template your values should lie on.
2. Press **Save as template …** and give it a name. The saved file embeds
   the chosen template's values under yours; it has no `use:` and no brand.
   (Not available in My settings.)

A template can then be used from the theme with `use:`; how to create and
apply your own is described in the Admin Guide, page *Theming*. The group
**Rahmen** takes effect only after saving.

Without a theme of its own, an instance shows the **Editorial default**
(no top bar, see [[reading-and-navigating]]). For the look before 1.2.5
choose the template `rotecodefraktion`.

## Stylesheet

In the instance and in a space the page shows a **Stylesheet** strip next to
the brand: an own CSS file from the repository (`_meta/theme.css`), loaded
after the theme and **without any design checks**. The strip shows whether
there is a file, its size and version, and the fonts next to it (name, size,
valid or missing). **Upload stylesheet** and **Remove stylesheet** change the
file; fonts come only through Git. A file that breaks the rules is not
loaded, and the strip lists the problems with their line. The stylesheet
applies to every page, this one and the building-block preview included; if
it breaks the page, **Show without stylesheet** opens it without; you can
also add `?ohne-stylesheet` to the address yourself
(`/einstellungen/erscheinungsbild?ohne-stylesheet`). The operator's own
stylesheet stays in place. Your
personal settings have no stylesheet.

## Brand

In the instance and in a space you can set a **name** (it replaces "f451"
in the header and the browser title) and a **logo**; the **favicon** is
instance only. Logo and favicon are SVG files of at most 256 KB. A space
inherits name and logo from the instance unless it sets its own.

The operator's view — setting up the instance repository, the files,
contrast thresholds and caches — is in the Admin Guide, page *Theming*.
