import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { ImportPanel } from '../../../../../components/import-panel'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getT } from '../../../../../lib/i18n/server'
import { importAvailable, parseImportOffer, type ImportOffer } from '../../../../../lib/import-job'
import { apiImportInstancesPath, decodeRouteParam } from '../../../../../lib/urls'

interface ImportPageProps {
  params: Promise<{ space: string }>
}

/**
 * Import/export page of a space (#128, #90). Loads the operator's BookStack
 * allow-list and the file import limit server-side and hands them to the
 * client island {@link ImportPanel}, which starts jobs and polls them. With
 * neither source on offer the page answers 404, like the hidden sidebar link. Space access itself is checked by the API when a job starts.
 */
export default async function ImportPage({ params }: ImportPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined
  const { t } = await getT()

  let offer: ImportOffer
  try {
    offer = parseImportOffer(await apiFetch<unknown>(apiImportInstancesPath(), { cookie: cookieHeader }))
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
      notFound()
    }
    throw err
  }
  if (!importAvailable(offer)) {
    notFound()
  }

  return (
    <main className="main full doc-pad">
      <h1 className="import-title">{t('import.pageTitle')}</h1>
      <p className="import-intro">{t('import.intro')}</p>
      <ImportPanel space={spaceId} instances={offer.bookstack} maxUploadMb={offer.maxUploadMb} office={offer.office} />
    </main>
  )
}
