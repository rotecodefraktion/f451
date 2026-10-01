import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import type { MarkdownDiff } from '@f451/markdown'
import { DiffView } from '../../../../../../components/review/diff-view'
import { ApiError, apiFetch } from '../../../../../../lib/api'
import { getT } from '../../../../../../lib/i18n/server.js'
import {
  decodeRouteParam,
  wikiPageHref,
  wikiPageReleaseHref,
  wikiPageVersionsHref,
  wikiSpaceHref,
} from '../../../../../../lib/urls'

interface VersionsPageProps {
  params: Promise<{ space: string; pageId: string }>
  searchParams: Promise<{ from?: string | string[] }>
}

interface VersionEntry {
  version: string
  releasedAt: string
  author: string
  note: string
  /** A frozen copy exists (#40). */
  release?: boolean
}

/** `GET /api/pages/:id/versions` (`apps/api/src/routes/versions.ts`). */
interface VersionsResponse {
  versioning: boolean
  versions: VersionEntry[]
}

/** `GET /api/pages/:id/diff?from=` (`apps/api/src/routes/versions.ts`). */
interface DiffResponse {
  from: VersionEntry
  to?: string
  diff: MarkdownDiff
}

/**
 * Versionsliste einer Seite und Vergleich einer Version mit dem heutigen Stand
 * (Seitenversionierung Etappe 2). Server Component nach dem Muster der
 * Review-Seite (`../review/page.tsx`); der Diff nutzt deren `DiffView`, damit
 * Review- und Versionsdiff nicht auseinanderlaufen (Spec „Wiederverwendung").
 *
 * 404 der API (Seite unbekannt ODER kein Leserecht) → `notFound()`, wie überall.
 * Ein nicht mehr verfügbarer Stand (410) oder eine unbekannte Version ist kein
 * Seitenfehler: Die Liste bleibt stehen, der Hinweis erscheint an Stelle des Diffs.
 */
export default async function VersionsPage({ params, searchParams }: VersionsPageProps) {
  const { space: rawSpace, pageId: rawPageId } = await params
  const spaceId = decodeRouteParam(rawSpace)
  const pageId = decodeRouteParam(rawPageId)
  const rawFrom = (await searchParams).from
  const from = Array.isArray(rawFrom) ? rawFrom[0] : rawFrom

  const cookie = (await cookies()).toString() || undefined
  const { t, locale } = await getT()
  const id = encodeURIComponent(pageId)

  let page: { title: string; version?: string }
  let list: VersionsResponse
  try {
    ;[page, list] = await Promise.all([
      apiFetch<{ title: string; version?: string }>(`/api/pages/${id}`, { cookie }),
      apiFetch<VersionsResponse>(`/api/pages/${id}/versions`, { cookie }),
    ])
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    return (
      <main className="main doc-pad">
        <div className="callout error" role="alert">
          <p>{t('read.versions.loadError')}</p>
          <div className="btn-row">
            <a href={wikiPageVersionsHref(spaceId, pageId, from)}>{t('read.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  let diff: DiffResponse | null = null
  let diffProblem: string | null = null
  if (from) {
    try {
      diff = await apiFetch<DiffResponse>(`/api/pages/${id}/diff?from=${encodeURIComponent(from)}`, { cookie })
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) diffProblem = t('read.versions.gone', { version: from })
      else if (err instanceof ApiError && err.status === 404) diffProblem = t('read.versions.unknownVersion', { version: from })
      else diffProblem = t('read.versions.loadError')
    }
  }

  // Serverseitig gerendert, keine Hydrierung — die Zeitzone des Servers ist
  // hier unkritisch; ein Freigabedatum ist ein Tag, keine Uhrzeit.
  const datum = (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' })
  const unveraendert =
    diff && diff.diff.summary.added + diff.diff.summary.changed + diff.diff.summary.removed === 0

  return (
    <>
      <main className="main">
        <div className="rhead">
          <span className="crumbs">
            <a href={wikiSpaceHref(spaceId)}>{spaceId}</a>
            <span className="sep">/</span>
            <a href={wikiPageHref(spaceId, pageId)}>{page.title}</a>
            <span className="sep">/</span>
            <b aria-current="page">{t('read.versions.heading')}</b>
          </span>
          <div className="rtitle">
            <h1>{diff ? t('read.versions.diffHeading', { from: diff.from.version }) : t('read.versions.heading')}</h1>
          </div>
          {diff ? (
            <div className="rmeta">
              <span>{diff.to ? t('read.versions.diffTo', { to: diff.to }) : t('read.versions.diffToday')}</span>
              <span className="grow" />
              <a className="rlink" href={wikiPageHref(spaceId, pageId)}>
                {t('read.versions.backToPage')}
              </a>
            </div>
          ) : null}
        </div>

        {diffProblem ? (
          <div className="doc-pad">
            <div className="callout warn" role="status">
              <p>{diffProblem}</p>
            </div>
          </div>
        ) : null}

        {diff && unveraendert ? (
          <div className="doc-pad">
            <p className="versions-empty">{t('read.versions.noChanges', { from: diff.from.version })}</p>
          </div>
        ) : diff ? (
          <DiffView diff={diff.diff} />
        ) : (
          <div className="doc-pad">
            {!list.versioning ? (
              <p className="versions-empty">{t('read.versions.unversioned')}</p>
            ) : list.versions.length === 0 ? (
              <p className="versions-empty">{t('read.versions.empty')}</p>
            ) : (
              <ol className="versions-list">
                {list.versions.map((v, i) => (
                  <li key={v.version}>
                    <div className="versions-head">
                      <b>{v.version}</b>
                      {i === 0 && v.version === page.version ? (
                        <span className="chip released">{t('read.versions.current')}</span>
                      ) : null}
                      {v.release ? <span className="chip info">{t('read.releases.marker')}</span> : null}
                      <span className="versions-meta">
                        {datum(v.releasedAt)} · {t('read.versions.by', { author: v.author })}
                      </span>
                    </div>
                    {v.note ? <p className="versions-note">{v.note}</p> : null}
                    {v.release ? (
                      <a href={wikiPageReleaseHref(spaceId, pageId, v.version)}>{t('read.releases.open')}</a>
                    ) : null}{' '}
                    {i > 0 || v.version !== page.version ? (
                      <a href={wikiPageVersionsHref(spaceId, pageId, v.version)}>{t('read.versions.compare')}</a>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </main>

      {/* `id="pane-rail"` — Ziel des rechten Daumenregisters, wie in der Review-Ansicht. */}
      {list.versioning && list.versions.length > 0 ? (
        <aside className="rail" id="pane-rail" aria-label={t('read.versions.railAriaLabel')}>
          <section className="rp">
            <h4>{t('read.versions.railHeading')}</h4>
            <ul className="changes">
              {list.versions.map((v) => (
                <li key={v.version}>
                  <a
                    href={wikiPageVersionsHref(spaceId, pageId, v.version)}
                    aria-current={v.version === from ? 'page' : undefined}
                  >
                    <span className="cl">
                      <b>{v.version}</b> {datum(v.releasedAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      ) : null}
    </>
  )
}
