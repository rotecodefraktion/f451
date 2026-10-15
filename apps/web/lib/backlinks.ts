/** One page linking to the current page, as `GET /api/pages/:id/backlinks`
 *  returns it (f451#97): the excerpts are plain text around each link. */
export interface Backlink {
  id: string
  title: string
  excerpts: string[]
}
