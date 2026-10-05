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
only. **Remove theme** deletes the theme file of the instance or space.
For an instance or space theme, a colour below the contrast threshold
blocks saving; see [[contrast]].

## Templates

The **Template** list above the table starts you from a ready-made set:
the five built-in ones (fokus, klar-warm, system-raster, werkbank,
rotecodefraktion), those of the instance, and in a space those of the
space. Your own values lie on top of the template. **Adopt template**
replaces your draft's values with the template's and clears the selection, so you
can change them one by one; **Save as template …** stores the chosen
template's values together with yours (not in My settings).

## Brand

In the instance and in a space you can set a **name** (it replaces "f451"
in the header and the browser title) and a **logo**; the **favicon** is
instance only. Logo and favicon are SVG files of at most 256 KB. A space
inherits name and logo from the instance unless it sets its own.

The operator's view — setting up the instance repository, the files,
contrast thresholds and caches — is in the Admin Guide, page *Theming*.
