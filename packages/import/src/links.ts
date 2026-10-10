const PLACEHOLDER = /\[([^\]]*)\]\(source:([^|)\s]+)\|([^)\s]*)\)/g

/** Replaces `[text](source:<id>|<url>)` with `[[p-id|text]]` once the f451
 *  id is known, otherwise with a plain link to the source URL. */
export function rewriteLinks(markdown: string, ids: Map<string, string>): string {
  return markdown.replace(PLACEHOLDER, (_m, text: string, id: string, url: string) => {
    const pageId = ids.get(id)
    if (pageId) return `[[${pageId}|${text}]]`
    return `[${text}](${url})`
  })
}
