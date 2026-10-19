import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { ImportPanel } from '../../../../../components/import-panel'
import type { TreeNodeData } from '../../../../../components/tree'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getT } from '../../../../../lib/i18n/server'
import { importAvailable, parseImportOffer, type ImportOffer } from '../../../../../lib/import-job'
import { apiImportInstancesPath, apiSpaceTreePath, decodeRouteParam } from '../../../../../lib/urls'

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

  // The page pickers (#175) need the tree; without access to it the pickers
  // only offer their empty option instead of breaking the page.
  let tree: TreeNodeData[]
  try {
    tree = await apiFetch<TreeNodeData[]>(apiSpaceTreePath(spaceId), { cookie: cookieHeader })
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      tree = []
    } else {
      throw err
    }
  }

  return (
    <main className="main full doc-pad">
      <h1 className="import-title">{t('import.pageTitle')}</h1>
      <p className="import-intro">{t('import.intro')}</p>
      <ImportPanel space={spaceId} instances={offer.bookstack} maxUploadMb={offer.maxUploadMb} office={offer.office} tree={tree} />
    </main>
  )
}
