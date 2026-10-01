import type { Classification, MetadataSchema } from '@f451/markdown'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { PageBody } from '../../../../../../../components/page-body'
import { CHECK_ICON, CLASSIFICATION_CHIP, WARN_ICON, type PageHeading } from '../../../../../../../components/page-view'
import { Rail } from '../../../../../../../components/rail'
import { ApiError, apiFetch } from '../../../../../../../lib/api'
import { getT } from '../../../../../../../lib/i18n/server.js'
import { formatUpdatedAt } from '../../../../../../../lib/page-view'
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
  headings: PageHeading[]
  tags: string[]
  relations: Record<string, string[]>
  metadata: Record<string, unknown>
  classification?: Classification
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
 * Chips and rail show the frozen copy's own class, tags and metadata — not
 * the living page's. No mini graph: its edges belong to the living page.
 */
export default async function ReleasePage({ params }: ReleasePageProps) {
  const { space: rawSpace, pageId: rawPageId, version: rawVersion } = await params
  const spaceId = decodeRouteParam(rawSpace)
  const pageId = decodeRouteParam(rawPageId)
  const version = decodeRouteParam(rawVersion)
  const cookie = (await cookies()).toString() || undefined
  const { t, locale } = await getT()

  let data: ReleaseResponse
  let metadataSchema: MetadataSchema | null
  try {
    ;[data, metadataSchema] = await Promise.all([
      apiFetch<ReleaseResponse>(
        `/api/pages/${encodeURIComponent(pageId)}/releases/${encodeURIComponent(version)}`,
        { cookie },
      ),
      apiFetch<MetadataSchema>(`/api/spaces/${encodeURIComponent(spaceId)}/metadata-schema`, { cookie }).catch(
        () => null,
      ),
    ])
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
    <>
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

        <div className="toolbar">
          <span className="grow" />
          {data.classification ? (
            <span
              className={`chip classification ${CLASSIFICATION_CHIP[data.classification]}`}
              title={t('read.classification.hint')}
            >
              {t(`read.classification.${data.classification}`)}
            </span>
          ) : null}
          <span className="chip released">
            {CHECK_ICON}
            {t('read.releases.crumb', { version: data.release.version })}
          </span>
        </div>

        <div className="notices">
          {data.classification === 'strictly-confidential' ? (
            <div className="notice warn classification-banner" role="note">
              <span className="ic">{WARN_ICON}</span>
              <div className="txt">
                <b>{t('read.classification.banner')}</b>
              </div>
            </div>
          ) : null}
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
      <Rail
        headings={data.headings}
        tags={data.tags}
        relations={data.relations}
        space={data.space}
        status={t('read.releases.crumb', { version: data.release.version })}
        updatedAtLabel={formatUpdatedAt(data.release.releasedAt, locale)}
        miniGraph={null}
        pageId={data.id}
        metadataSchema={metadataSchema}
        metadata={data.metadata}
      />
    </>
  )
}
