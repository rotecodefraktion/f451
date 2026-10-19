// The separator may arrive as `\|`: in a GFM table cell the serializer escapes
// the pipe, and the wikilink written there has to keep the escape, or its
// alias divider would split the cell.
const PLACEHOLDER = /\[([^\]]*)\]\(source:([^|)\s\\]+)(\\?)\|([^)\s]*)\)/g

/** Replaces `[text](source:<id>|<url>)` with `[[p-id|text]]` once the f451
 *  id is known, otherwise with a plain link to the source URL. The id may
 *  carry a heading anchor, `source:<id>#<slug>|<url>` → `[[p-id#slug|text]]`
 *  (#163). */
export function rewriteLinks(markdown: string, ids: Map<string, string>): string {
  return markdown.replace(PLACEHOLDER, (_m, text: string, raw: string, escape: string, url: string) => {
    const { pageId, anchor } = lookup(raw, ids)
    if (pageId) return `[[${pageId}${anchor}${escape}|${text}]]`
    return `[${text}](${url})`
  })
}

/** The whole id first, so a source id that itself contains `#` still matches;
 *  otherwise split at the last `#` — a slug never contains one. */
function lookup(raw: string, ids: Map<string, string>): { pageId: string | undefined; anchor: string } {
  const whole = ids.get(raw)
  if (whole) return { pageId: whole, anchor: '' }
  const hash = raw.lastIndexOf('#')
  if (hash === -1) return { pageId: undefined, anchor: '' }
  const slug = raw.slice(hash + 1)
  return { pageId: ids.get(raw.slice(0, hash)), anchor: slug.length === 0 ? '' : `#${slug}` }
}
