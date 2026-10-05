/**
 * With `--page-head: title` the frame renders the page's h1 in the title row
 * (`.doc-head`). If the rendered body opens with an h1 (`# Heading`), that
 * heading becomes the title row and is removed from the body; only without a
 * leading h1 does the title row fall back to the frontmatter `title:`. The
 * page never shows two h1 (client decision 2026-10-05, spec "`--page-head:
 * title` und das h1").
 *
 * `headingHtml` is the h1's inner HTML, inline markup (`<code>`, `<em>`, …)
 * kept. The body HTML is already sanitized by the markdown pipeline, so
 * rendering this fragment with `dangerouslySetInnerHTML` in the title row is
 * exactly as safe as rendering the body itself. The pipeline adds no anchor
 * link inside headings (only an `id` attribute on the h1, which is dropped
 * with the tag), so there is nothing else to strip.
 */

const LEADING_H1 = /^\s*<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i

export function takeLeadHeading(html: string): { headingHtml: string | null; rest: string } {
  const match = LEADING_H1.exec(html)
  if (!match) return { headingHtml: null, rest: html }
  return { headingHtml: match[1]!, rest: html.slice(match[0].length) }
}
