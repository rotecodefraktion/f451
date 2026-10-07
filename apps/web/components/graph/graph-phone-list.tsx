import Link from 'next/link'
import { Attribution } from '../attribution'
import { pagesByConnections } from '../../lib/graph/linked'
import type { GraphData } from '../../lib/graph/types'
import { getT } from '../../lib/i18n/server.js'
import { wikiPageHref, wikiSpaceHref } from '../../lib/urls'

export interface GraphPhoneListProps {
  graph: GraphData
  space: string
}

/** The graph view's stand-in on the phone (f451#1): every page of the space,
 *  most connected first. Rendered beside `<GraphView>`; `66-telefon.css`
 *  shows this one below the phone threshold and the canvas above it, so the
 *  markup is the same on server and client. */
export async function GraphPhoneList({ graph, space }: GraphPhoneListProps) {
  const { t } = await getT()
  const pages = pagesByConnections(graph)
  return (
    <div className="graph-phone">
      <p className="graph-phone-hint">{t('read.graph.phoneHint')}</p>
      <Link className="graph-phone-back" href={wikiSpaceHref(space)}>
        {t('read.graph.backToSpace')}
      </Link>
      <ul className="graph-phone-list">
        {pages.map((p) => (
          <li key={p.id}>
            <Link href={wikiPageHref(space, p.id)}>
              <span className="graph-phone-title">{p.title}</span>
              <span className="graph-phone-count">{t('read.graph.connections', { count: p.connections })}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* The graph variant has no page tree, so the attribution and the
          phone copy of the legal links live here. */}
      <Attribution />
    </div>
  )
}
