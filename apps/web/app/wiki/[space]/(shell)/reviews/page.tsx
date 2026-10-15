import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { ReviewsList } from '../../../../../components/reviews-list'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getT } from '../../../../../lib/i18n/server'
import type { ReviewItem } from '../../../../../lib/reviews-state'
import { apiSpaceReviewsPath, decodeRouteParam } from '../../../../../lib/urls'

interface ReviewsPageProps {
  params: Promise<{ space: string }>
}

interface ReviewsResponse {
  versioning: boolean
  reviews: ReviewItem[]
}

/**
 * Review overview of a space (#131): every draft with an open review, with
 * a bulk release in the client island {@link ReviewsList}. The API answers
 * 404 without read access (→ not found) and 403 for readers without write
 * access (→ a notice, not an error card: readers never see drafts).
 */
export default async function ReviewsPage({ params }: ReviewsPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined
  const { t } = await getT()

  let data: ReviewsResponse
  try {
    data = await apiFetch<ReviewsResponse>(apiSpaceReviewsPath(spaceId), { cookie: cookieHeader })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    if (err instanceof ApiError && (err.status === 403 || err.status === 502)) {
      return (
        <main className="main full doc-pad">
          <h1 className="reviews-title">{t('reviews.pageTitle')}</h1>
          <div className={`callout ${err.status === 403 ? 'info' : 'error'}`} role={err.status === 403 ? 'status' : 'alert'}>
            {err.status === 403 ? t('reviews.forbidden') : t('reviews.loadFailed')}
          </div>
        </main>
      )
    }
    throw err
  }

  return (
    <main className="main full doc-pad">
      <h1 className="reviews-title">{t('reviews.pageTitle')}</h1>
      <p className="reviews-intro">{t('reviews.intro')}</p>
      <ReviewsList space={spaceId} versioning={data.versioning} initial={data.reviews} />
    </main>
  )
}
