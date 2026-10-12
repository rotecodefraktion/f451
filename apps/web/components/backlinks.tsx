import Link from 'next/link'
import type { Backlink } from '../lib/backlinks'
import { getT } from '../lib/i18n/server.js'
import { wikiPageHref } from '../lib/urls'

export interface BacklinksProps {
  backlinks: Backlink[]
  space: string
}

/** Pages linking to the current one, each with the passages around its links
 *  (f451#97). Renders nothing for an empty list. Server Component: the rail
 *  around it is one too. */
export async function Backlinks({ backlinks, space }: BacklinksProps) {
  if (backlinks.length === 0) return null
  const { t } = await getT()
  return (
    <section className="rp rp-backlinks">
      <h4>{t('read.rail.backlinks')}</h4>
      <ul className="backlinks">
        {backlinks.map((b) => (
          <li key={b.id}>
            <Link href={wikiPageHref(space, b.id)}>{b.title}</Link>
            {b.excerpts.map((excerpt, i) => (
              <p className="bl-excerpt" key={i}>
                {excerpt}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  )
}
