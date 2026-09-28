import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import type { TreeNodeData } from '../../../../components/tree'
import { ApiError, apiFetch } from '../../../../lib/api'
import { apiSpaceTreePath, decodeRouteParam, wikiPageHref, wikiSpaceHref } from '../../../../lib/urls'

interface SpaceIndexPageProps {
  params: Promise<{ space: string }>
}

/**
 * Space-Startseite: leitet auf die erste Wurzelseite weiter, falls vorhanden.
 * Ohne Seiten zeigt sie einen Hinweis statt einer leeren Seite. Rendert als
 * Kind von `[space]/layout.tsx`, das Topbar/Sidebar bereits liefert — hier
 * kommt nur der `<main>`-Inhalt.
 *
 * Ruft den Tree-Endpunkt erneut ab (dieselbe URL wie im Layout — Next
 * dedupliziert identische `fetch`-Aufrufe innerhalb eines Request-Durchlaufs),
 * damit diese Seite unabhängig vom Layout ihren eigenen Fehler-/404-Zustand
 * behandeln kann.
 */
export default async function SpaceIndexPage({ params }: SpaceIndexPageProps) {
  const { space: rawSpaceId } = await params
  // s. Kommentar in `[space]/layout.tsx`: `params.space` ist noch URL-kodiert.
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString() || undefined

  let tree: TreeNodeData[]
  try {
    tree = await apiFetch<TreeNodeData[]>(apiSpaceTreePath(spaceId), { cookie: cookieHeader })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    return (
      <main className="main full doc-pad">
        <div className="callout error" role="alert">
          <p>Der Server ist aktuell nicht erreichbar.</p>
          <div className="btn-row">
            <a href={wikiSpaceHref(spaceId)}>Erneut versuchen</a>
          </div>
        </div>
      </main>
    )
  }

  if (tree.length > 0) {
    redirect(wikiPageHref(spaceId, tree[0]!.id))
  }

  return (
    <main className="main full doc-pad">
      <h1
        style={{
          margin: '0 0 var(--space-2)',
          fontSize: 'var(--text-2xl)',
          fontWeight: 'var(--weight-strong)',
          letterSpacing: '-0.02em',
        }}
      >
        Noch keine Seiten
      </h1>
      <p style={{ color: 'var(--color-text-muted)', maxWidth: '72ch', margin: 0 }}>
        Dieser Space enthält aktuell keine Seiten.
      </p>
    </main>
  )
}
