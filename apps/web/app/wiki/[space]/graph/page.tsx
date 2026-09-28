import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { AccountMenu } from '../../../../components/account-menu'
import { GraphView } from '../../../../components/graph/graph-view'
import { ApiError, apiFetch } from '../../../../lib/api'
import type { GraphData } from '../../../../lib/graph/types'
import { getMe } from '../../../../lib/session'
import { apiSpaceGraphPath, decodeRouteParam, wikiGraphHref } from '../../../../lib/urls'
import { Shell } from '../../../shell'

interface SpaceSummary { id: string; name: string; defaultLang: string }

interface GraphPageProps { params: Promise<{ space: string }> }

/**
 * Graph-Ansicht eines Space (Phase 3b, Mockup docs/design/mockups/graph.html).
 * Server Component: lädt Graph + Space-Liste, das Rendering/die Interaktion
 * übernimmt die Client-Komponente (Task 4/5). Vollbild-Layout über
 * `<Shell variant="graph">` — bewusst ohne Seitenbaum (abgenommenes Mockup).
 */
export default async function GraphPage({ params }: GraphPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined

  const me = await getMe(cookieHeader)
  if (!me) redirect(`/?next=${encodeURIComponent(wikiGraphHref(spaceId))}`)

  let graph: GraphData
  let spaces: SpaceSummary[]
  try {
    ;[graph, spaces] = await Promise.all([
      apiFetch<GraphData>(apiSpaceGraphPath(spaceId), { cookie: cookieHeader }),
      apiFetch<SpaceSummary[]>('/api/spaces', { cookie: cookieHeader }),
    ])
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }
  const space = spaces.find((s) => s.id === spaceId)
  if (!space) notFound()

  return (
    <Shell
      variant="graph"
      space={space.name}
      spaces={spaces}
      currentSpaceId={spaceId}
      avatar={<AccountMenu displayName={me.displayName} />}
    >
      <GraphView
        graph={graph}
        space={spaceId}
        spaceName={space.name}
        spaces={spaces.map((s) => ({ id: s.id, name: s.name }))}
      />
    </Shell>
  )
}
