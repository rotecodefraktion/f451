import type { MetadataSchema } from '@f451/markdown'
import { Fragment } from 'react'
import { linkedPages } from '../lib/graph/linked'
import { miniGraphModel } from '../lib/graph/mini'
import type { GraphData } from '../lib/graph/types'
import { getT } from '../lib/i18n/server.js'
import { buildMetadataView } from '../lib/metadata-view'
import { relationLabel } from '../lib/page-view'
import { LinkedPages } from './linked-pages'
import { MiniGraph } from './mini-graph'
import type { PageHeading } from './page-view'

export interface RailProps {
  /** Überschriften der Seite (für das Inhaltsverzeichnis). */
  headings: PageHeading[]
  tags: string[]
  relations: Record<string, string[]>
  /** Space-Id (Metadaten-Zeile). */
  space: string
  /** Status-Label „Released"/„Archiviert"/„Entwurf"/„In Review" (redundant zum
   *  Chip in der Toolbar — Aufrufer baut es über `lib/page-view.ts#pageStatusLabel`,
   *  damit beide Anzeigen nie widersprechen, Phase 2d Task 6). Dies ist der
   *  fest verdrahtete WORKFLOW-Status, unabhängig von einem evtl.
   *  schema-eigenen `status`-Feld (s. `metadataSchema`/`metadata` unten) —
   *  beide werden nebeneinander mit ihrem jeweils eigenen Label gerendert,
   *  nie zusammengeführt (s. Kommentar bei `metadataEntries` unten). */
  status: string
  /** Bereits formatiertes, lokalisiertes Aktualisierungsdatum. */
  updatedAtLabel: string
  /** Nachbarschafts-Graph der aktuellen Seite (`GET /api/pages/:id/graph?depth=1`,
   *  Phase 3b Task 6) für den Mini-Graph „Verknüpfte Seiten". `null`, wenn der
   *  Graph-Request fehlgeschlagen ist — die Leseansicht bricht dafür nie
   *  (Aufrufer fängt den Fehler ab); der Mini-Graph fällt dann einfach aus. */
  miniGraph: GraphData | null
  /** Id der aktuellen Seite (Zentrum des Mini-Graphen). */
  pageId: string
  /** Metadaten-Schema des Space (`GET /api/spaces/:space/metadata-schema`,
   *  Metadaten-Feature M2). `null`, wenn der Schema-Request fehlgeschlagen ist
   *  oder kein Schema konfiguriert ist — Fail-Soft wie `miniGraph`: die Rail
   *  zeigt dann einfach keinen zusätzlichen Metadaten-Block (keine Regression
   *  zum Verhalten vor M2). */
  metadataSchema: MetadataSchema | null
  /** Rohe Frontmatter-Metadaten-Werte der Seite (`GET /api/pages/:id`, Feld
   *  `metadata`). Formatierung/Filterung übernimmt
   *  `lib/metadata-view.ts#buildMetadataView`. */
  metadata: Record<string, unknown>
}

/**
 * Rechte Info-Leiste der Leseansicht (`.rail`, abgenommenes Mockup): gestapelte
 * `.card.rp`-Sektionen für Inhaltsverzeichnis (Sprung-Anker `#slug`, nach
 * `depth` eingerückt), Tags, Metadaten und Relationen (nach Typ gruppiert).
 * Reine Server Component. Wird ab 1160px per CSS ausgeblendet.
 *
 * Die h1-Ebene (Seitentitel) bleibt im Inhaltsverzeichnis außen vor — sie ist
 * bereits als Titel/Breadcrumb sichtbar; das TOC listet die Gliederung ab h2.
 */
export async function Rail({
  headings,
  tags,
  relations,
  space,
  status,
  updatedAtLabel,
  miniGraph,
  pageId,
  metadataSchema,
  metadata,
}: RailProps) {
  const { t, locale } = await getT()
  const tocEntries = headings.filter((h) => h.depth >= 2)
  const relationGroups = Object.entries(relations).filter(([, targets]) => targets.length > 0)
  const mini = miniGraph ? miniGraphModel(miniGraph, pageId) : null
  // The phone shows these as a list instead of the mini graph (f451#1).
  const linked = miniGraph ? linkedPages(miniGraph, pageId) : null
  const hasLinked = linked !== null && (linked.linksTo.length > 0 || linked.linkedFrom.length > 0)
  // Schema-getriebene Zusatzfelder (Metadaten-Feature M2) — unabhängig vom
  // festen Workflow-`status` oben; ein Schema-Feld mit `key: 'status'`
  // erscheint hier als GEWÖHNLICHER, eigenständiger Eintrag mit seinem
  // eigenen Label (s. `metadata-view.ts#buildMetadataView`-Kommentar).
  const metadataEntries = buildMetadataView(metadataSchema, metadata, locale)

  return (
    // `id="pane-rail"` ist das Ziel des `aria-controls` am rechten
    // Daumenregister (`app/pane-edges.tsx`) — der Schalter, der diese Leiste
    // ein- und ausklappt.
    <aside className="rail" id="pane-rail" aria-label={t('read.rail.ariaLabel')}>
      {tocEntries.length > 0 ? (
        // `rp-toc`: die Telefon-Leiste zeigt diesen Abschnitt als „Gliederung",
        // alle übrigen als „Info" (`app/phone-bar.tsx`).
        <section className="rp rp-toc">
          <h4>{t('read.rail.toc')}</h4>
          <ul className="toc">
            {tocEntries.map((h) => (
              // `data-sub` marks entries below the top level: they take no
              // chapter number under `toc-style: numbered-progress` (60-chrome-leiste.css).
              <li key={h.slug} data-sub={h.depth > 2 ? '' : undefined}>
                <a
                  href={`#${h.slug}`}
                  style={{
                    paddingLeft: `calc(var(--space-3) + ${h.depth - 2} * var(--space-4))`,
                  }}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tags.length > 0 ? (
        <section className="rp">
          <h4>{t('read.rail.tags')}</h4>
          <div className="tags">
            {tags.map((tag) => (
              <span className="tag" key={tag}>
                <span className="h">#</span>
                {tag}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rp">
        <h4>{t('read.rail.metadata')}</h4>
        <dl className="meta">
          <dt>{t('read.rail.status')}</dt>
          <dd>{status}</dd>
          <dt>{t('read.rail.space')}</dt>
          <dd>{space}</dd>
          <dt>{t('read.rail.updated')}</dt>
          <dd>{updatedAtLabel}</dd>
          {metadataEntries.map((entry) => (
            <Fragment key={entry.key}>
              <dt>{entry.label}</dt>
              <dd>
                {entry.kind === 'chips' ? (
                  <div className="tags">
                    {entry.values.map((value) => (
                      <span className="tag" key={value}>
                        {value}
                      </span>
                    ))}
                  </div>
                ) : (
                  entry.value
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      </section>

      {mini !== null || relationGroups.length > 0 || hasLinked ? (
        <section className="rp">
          <h4>{t('read.rail.relatedPages')}</h4>
          {mini ? <MiniGraph model={mini} space={space} /> : null}
          {linked && hasLinked ? <LinkedPages groups={linked} space={space} /> : null}
          {relationGroups.map(([type, targets]) => (
            <div className="rel-group" key={type}>
              <div className="rel-type">{relationLabel(t, type)}</div>
              <ul className="rel-list">
                {targets.map((target) => (
                  <li key={target}>{target}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </aside>
  )
}
