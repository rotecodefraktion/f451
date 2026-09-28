'use client'

import Link from 'next/link'
import { MINI_VIEW, truncateTitle, type MiniGraphModel } from '../lib/graph/mini'
import { useT } from '../lib/i18n/provider'
import { wikiPageHref } from '../lib/urls'

export interface MiniGraphProps {
  model: MiniGraphModel
  space: string
}

/** Mini-Graph „Verknüpfte Seiten" (Mockup leseansicht.html): Zentrum als
 *  Akzent-Pill, Nachbarn als neutrale Kreise mit Speichen — statisch, ohne
 *  Kantentyp-/Status-Codierung (bewusst; die volle Semantik hat die
 *  Graph-Ansicht). Nachbarn verlinken auf ihre Leseansicht.
 *
 *  Container-Klasse bewusst `.mini-graph`, nicht `.graph` wie im Mockup: das
 *  Mockup-Markup benennt den Container schlicht `.graph`, das kollidiert
 *  aber mit der gleichnamigen globalen Regel für den Vollbild-Graph-Container
 *  (`.graph { position:absolute; inset:0; … }`, `app/graph.css`) — hier in
 *  der Rail hätte das den Mini-Graph absolut über die ganze Spalte gelegt
 *  (Fix-Runde 1, Review-Befund Critical). */
export function MiniGraph({ model, space }: MiniGraphProps) {
  const { t } = useT()
  const { center, neighbors } = model
  const centerTitle = truncateTitle(center.title, 24)
  const pillWidth = Math.min(200, Math.max(64, centerTitle.length * 7 + 16))
  return (
    <div className="card mini-graph">
      {/* role="group" statt "img": das SVG enthält fokussierbare Nachbar-Links
          (next/link); "img" erklärt den Inhalt für AT als flaches Bild und
          entfernt die Kind-Links aus dem Accessibility-Baum. "group" erlaubt
          interaktive Nachkommen und behält das beschreibende Label. */}
      <svg viewBox={`0 0 ${MINI_VIEW.width} ${MINI_VIEW.height}`} role="group" aria-label={t('graph.mini.ariaLabel')}>
        <g>
          {neighbors.map((n) => (
            <line key={`l-${n.id}`} x1={MINI_VIEW.cx} y1={MINI_VIEW.cy} x2={n.x} y2={n.y} stroke="var(--color-border-strong)" strokeWidth={1.4} />
          ))}
          <rect x={MINI_VIEW.cx - pillWidth / 2} y={MINI_VIEW.cy - 12} width={pillWidth} height={24} rx={12} fill="var(--color-accent)" />
          <text x={MINI_VIEW.cx} y={MINI_VIEW.cy + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--color-accent-contrast)">
            {centerTitle}
          </text>
          {neighbors.map((n) => (
            <Link key={n.id} href={wikiPageHref(space, n.id)}>
              <g>
                <circle cx={n.x} cy={n.y} r={9} fill="var(--color-bg)" stroke="var(--color-border-strong)" strokeWidth={1.4} />
                <text x={n.x} y={n.y + 20} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">
                  {n.title.length > 14 ? `${n.title.slice(0, 13)}…` : n.title}
                </text>
              </g>
            </Link>
          ))}
        </g>
      </svg>
    </div>
  )
}
