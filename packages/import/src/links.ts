// The separator may arrive as `\|`: in a GFM table cell the serializer escapes
// the pipe, and the wikilink written there has to keep the escape, or its
// alias divider would split the cell.
const PLACEHOLDER = /\[([^\]]*)\]\(source:([^|)\s\\]+)(\\?)\|([^)\s]*)\)/g

/** Replaces `[text](source:<id>|<url>)` with `[[p-id|text]]` once the f451
 *  id is known, otherwise with a plain link to the source URL. */
export function rewriteLinks(markdown: string, ids: Map<string, string>): string {
  return markdown.replace(PLACEHOLDER, (_m, text: string, id: string, escape: string, url: string) => {
    const pageId = ids.get(id)
    if (pageId) return `[[${pageId}${escape}|${text}]]`
    return `[${text}](${url})`
  })
}
