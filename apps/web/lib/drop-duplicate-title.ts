/**
 * With `--page-head: title` the frame renders the page's h1 from the
 * frontmatter `title:`. A page that also opens with `# <same title>` would
 * then show its title twice — this drops that leading h1 from the rendered
 * body HTML. A first heading that differs from the title, or an h1 that is
 * not the first element, stays (spec "`--page-head: title` und das h1").
 */

const LEADING_H1 = /^\s*<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i

/** Text content of rendered HTML: tags stripped, the entities the markdown
 *  pipeline emits decoded (`&amp;` last, so `&amp;lt;` stays `&lt;`),
 *  whitespace collapsed, trimmed. */
function htmlText(html: string): string {
  return plainText(
    html
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'),
  )
}

/** The frontmatter title is plain text, not HTML — `Backup of <db>` must
 *  keep its `<db>`. Only whitespace is collapsed and trimmed. */
function plainText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function dropDuplicateTitle(html: string, title: string): string {
  const match = LEADING_H1.exec(html)
  if (!match) return html
  if (htmlText(match[1]!) !== plainText(title)) return html
  return html.slice(match[0].length)
}
