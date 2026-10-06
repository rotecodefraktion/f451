/**
 * Whether the reading view places footnotes as margin notes (switch
 * `--marginalia`, f451#63). Pure, so the rule is testable without a request.
 * Only `list` keeps the GFM end list; missing or unknown values fall back to
 * the Editorial default `margin`.
 */
export function placesFootnotes(switches: Record<string, string> | undefined): boolean {
  return switches?.marginalia !== 'list'
}
