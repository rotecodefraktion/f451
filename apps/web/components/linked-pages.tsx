import Link from 'next/link'
import type { LinkedGroups } from '../lib/graph/linked'
import { getT } from '../lib/i18n/server.js'
import { wikiPageHref } from '../lib/urls'

export interface LinkedPagesProps {
  groups: LinkedGroups
  space: string
}

/** Linked pages as a plain list, split by direction — the phone's stand-in
 *  for the mini graph (f451#1). Both stay in the DOM; `66-telefon.css`
 *  decides which one shows, so server and client render the same markup.
 *  Server Component: the rail around it is one too. */
export async function LinkedPages({ groups, space }: LinkedPagesProps) {
  const { linksTo, linkedFrom } = groups
  if (linksTo.length === 0 && linkedFrom.length === 0) return null
  const { t } = await getT()
  const sections = [
    { key: 'linksTo', heading: t('read.rail.linksTo'), pages: linksTo },
    { key: 'linkedFrom', heading: t('read.rail.linkedFrom'), pages: linkedFrom },
  ].filter((s) => s.pages.length > 0)
  return (
    <div className="linked-pages">
      {sections.map((s) => (
        <div className="linked-group" key={s.key}>
          <h5>{s.heading}</h5>
          <ul>
            {s.pages.map((p) => (
              <li key={p.id}>
                <Link href={wikiPageHref(space, p.id)}>{p.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
