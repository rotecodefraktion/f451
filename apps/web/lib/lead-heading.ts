import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'

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
 *
 * The split is tree-based, never string-based (security finding F-01): the
 * serializer of the markdown pipeline does not escape `<`/`>` inside
 * attribute values, so a `</h1>` in a link title would end a regex match
 * early and leak the rest as raw markup. Here the HTML is parsed into a tree
 * and both parts are serialized from whole nodes. An attribute value stays an
 * attribute value of its element by construction; `toHtml` only ever writes it
 * back inside that element's start tag, so nothing can turn it into markup.
 */
export function takeLeadHeading(html: string): { headingHtml: string | null; rest: string } {
  const nodes = fromHtml(html, { fragment: true }).children

  let index = 0
  while (index < nodes.length) {
    const node = nodes[index]!
    if (node.type !== 'text' || node.value.trim() !== '') break
    index++
  }

  const first = nodes[index]
  if (!first || first.type !== 'element' || first.tagName !== 'h1') {
    return { headingHtml: null, rest: html }
  }
  return { headingHtml: toHtml(first.children), rest: toHtml(nodes.slice(index + 1)) }
}
