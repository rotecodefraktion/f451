import { decodeRouteParam } from './urls.js'

/**
 * Space id of a request pathname, or `null` outside a space.
 *
 * Every space route lives under `/wiki/<space>/…` (page, edit, review,
 * versions, releases, report, graph, …), with the id encoded as one segment by
 * `wikiSpaceHref`. The segment is decoded the same way route params are
 * (`decodeRouteParam`). `/wiki` itself (the space list) has no space. A
 * malformed percent-encoding yields `null` rather than throwing — the theme
 * then simply falls back to the instance layer.
 */
export function spaceFromPath(pathname: string): string | null {
  const match = /^\/wiki\/([^/]+)/.exec(pathname)
  if (!match) return null
  try {
    const space = decodeRouteParam(match[1]!)
    return space.length > 0 ? space : null
  } catch {
    return null
  }
}
