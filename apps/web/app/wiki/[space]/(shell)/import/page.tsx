import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { ImportPanel } from '../../../../../components/import-panel'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getT } from '../../../../../lib/i18n/server'
import { apiImportInstancesPath, decodeRouteParam } from '../../../../../lib/urls'

interface ImportPageProps {
  params: Promise<{ space: string }>
}

/**
 * Import/export page of a space (#128). Loads the operator's BookStack
 * allow-list server-side and hands it to the client island
 * {@link ImportPanel}, which starts jobs and polls them. Without an
 * allow-list the feature is off and the page answers 404, like the hidden
 * sidebar link. Space access itself is checked by the API when a job starts.
 */
export default async function ImportPage({ params }: ImportPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined
  const { t } = await getT()

  let instances: string[]
  try {
    const res = await apiFetch<{ bookstack?: unknown }>(apiImportInstancesPath(), { cookie: cookieHeader })
    instances = Array.isArray(res.bookstack) ? res.bookstack.filter((u): u is string => typeof u === 'string') : []
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
      notFound()
    }
    throw err
  }
  if (instances.length === 0) {
    notFound()
  }

  return (
    <main className="main full doc-pad">
      <h1 className="import-title">{t('import.pageTitle')}</h1>
      <p className="import-intro">{t('import.intro')}</p>
      <ImportPanel space={spaceId} instances={instances} />
    </main>
  )
}
