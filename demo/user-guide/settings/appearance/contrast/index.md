---
id: contrast
title: Contrast and AA
description: What WCAG AA means, how f451 checks colour pairs, and what the report "Values below AA" is.
tags: [guide, settings, theming, accessibility]
lang: en
---

# Contrast and AA

AA is the middle level of the WCAG (Web Content Accessibility Guidelines),
the standard for accessible websites, which laws such as the German
Barrierefreiheitsstärkungsgesetz also refer to. For colours it defines
how far text and background must differ in lightness — the contrast
ratio. Black on white is 21:1; the same colour on itself would be 1:1.
Text needs at least 4.5:1 (large text 3:1); controls, symbols and borders
at least 3:1.

## What f451 checks

On every saved theme, f451 recalculates the contrast for fixed colour
pairs — text on paper, chip text on chip surface, line numbers, focus
ring — separately for light and dark.

There are two levels. **Below the configured threshold, saving is
refused.** Above it but below AA, a value is a **warning**: it does not
block, but stays visible on the row and appears in the report.

## The three states at a row

Every colour row shows the result for its pair:

- **✓** — meets the threshold.
- **Warning** — above the threshold but below the AA reference. The value
  is saved, and the note stays on the row.
- **Error** — below the threshold. In the instance and in a space, saving
  is blocked until you fix it. In [[my-settings]] it is only a warning:
  nobody else is affected.

## The report "Values below AA"

The report is the complete list of values below AA, for everyone who can
change them — and the basis for an accessibility statement. The
thresholds themselves are set by the instance operator (Admin Guide, page
*Theming*).
