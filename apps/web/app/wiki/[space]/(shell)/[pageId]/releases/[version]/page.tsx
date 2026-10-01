import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { PageBody } from '../../../../../../../components/page-body'
import { ApiError, apiFetch } from '../../../../../../../lib/api'
import { getT } from '../../../../../../../lib/i18n/server.js'
import {
  decodeRouteParam,
  wikiPageHref,
  wikiPageReleaseHref,
  wikiPageVersionsHref,
  wikiSpaceHref,
} from '../../../../../../../lib/urls'

interface ReleasePageProps {
  params: Promise<{ space: string; pageId: string; version: string }>
}

/** `GET /api/pages/:id/releases/:version` (`apps/api/src/routes/versions.ts`). */
interface ReleaseResponse {
  id: string
  space: string
  title: string
  html: string
  classification?: string
  release: {
    version: string
    releasedAt: string
    author: string
    note: string
    tampered: boolean
    current?: string
  }
}

/**
 * A frozen release of a page (#40): read only, no edit or release actions.
 * The banner says which version this is and leads back to the living page.
 */
export default async function ReleasePage({ params }: ReleasePageProps) {
  const { space: rawSpace, pageId: rawPageId, version: rawVersion } = await params
  const spaceId = decodeRouteParam(rawSpace)
  const pageId = decodeRouteParam(rawPageId)
  const version = decodeRouteParam(rawVersion)
  const cookie = (await cookies()).toString() || undefined
  const { t, locale } = await getT()

  let data: ReleaseResponse
  try {
    data = await apiFetch<ReleaseResponse>(
      `/api/pages/${encodeURIComponent(pageId)}/releases/${encodeURIComponent(version)}`,
      { cookie },
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    return (
      <main className="main doc-pad">
        <div className="callout error" role="alert">
          <p>{t('read.releases.loadError')}</p>
          <div className="btn-row">
            <a href={wikiPageReleaseHref(spaceId, pageId, version)}>{t('read.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  const date = new Date(data.release.releasedAt).toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' })
  const { current } = data.release

  return (
    <main className="main">
      <div className="rhead">
        <span className="crumbs">
          <a href={wikiSpaceHref(spaceId)}>{spaceId}</a>
          <span className="sep">/</span>
          <a href={wikiPageHref(spaceId, pageId)}>{data.title}</a>
          <span className="sep">/</span>
          <b aria-current="page">{t('read.releases.crumb', { version: data.release.version })}</b>
        </span>
      </div>

      <div className="notices">
        <div className="notice draft release-banner" role="note">
          <div className="txt">
            <b>{t('read.releases.banner', { version: data.release.version, date })}</b>{' '}
            {data.release.author ? t('read.versions.by', { author: data.release.author }) : null}
            {data.release.note ? <span className="release-note"> — {data.release.note}</span> : null}
          </div>
          <span className="grow" />
          <a href={wikiPageHref(spaceId, pageId)}>
            {current && current !== data.release.version
              ? t('read.releases.toCurrent', { version: current })
              : t('read.releases.toPage')}
          </a>
        </div>
        {data.release.tampered ? (
          <div className="notice warn" role="status">
            <div className="txt">
              <b>{t('read.releases.tampered')}</b>
            </div>
          </div>
        ) : null}
      </div>

      <div className="body">
        <PageBody html={data.html} />
      </div>

      <div className="doc-pad">
        <a href={wikiPageVersionsHref(spaceId, pageId)}>{t('read.releases.allVersions')}</a>
      </div>
    </main>
  )
}
