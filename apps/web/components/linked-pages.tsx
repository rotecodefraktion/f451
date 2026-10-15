import Link from 'next/link'
import type { LinkedGroups } from '../lib/graph/linked'
import { getT } from '../lib/i18n/server.js'
import { wikiPageHref } from '../lib/urls'

export interface LinkedPagesProps {
  groups: LinkedGroups
  space: string
}

/** Outgoing links as a plain list — the phone's stand-in for the mini graph
 *  (f451#1). Both stay in the DOM; `66-telefon.css` decides which one shows,
 *  so server and client render the same markup. Incoming links are not listed
 *  here: the backlinks section (`backlinks.tsx`, f451#97) covers them on every
 *  screen size. Server Component: the rail around it is one too. */
export async function LinkedPages({ groups, space }: LinkedPagesProps) {
  const { linksTo } = groups
  if (linksTo.length === 0) return null
  const { t } = await getT()
  return (
    <div className="linked-pages">
      <div className="linked-group">
        <h5>{t('read.rail.linksTo')}</h5>
        <ul>
          {linksTo.map((p) => (
            <li key={p.id}>
              <Link href={wikiPageHref(space, p.id)}>{p.title}</Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
