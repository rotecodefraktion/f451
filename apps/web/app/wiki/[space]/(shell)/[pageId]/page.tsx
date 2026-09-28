import type { MetadataSchema } from '@f451/markdown'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { PageView, type PageData } from '../../../../../components/page-view'
import { Rail } from '../../../../../components/rail'
import { ApiError, apiFetch } from '../../../../../lib/api'
import type { GraphData } from '../../../../../lib/graph/types'
import { getT } from '../../../../../lib/i18n/server.js'
import { formatUpdatedAt, pageStatusLabel } from '../../../../../lib/page-view'
import { decodeRouteParam, wikiPageHref } from '../../../../../lib/urls'

interface PageProps {
  params: Promise<{ space: string; pageId: string }>
}

/**
 * Leseansicht einer einzelnen Wiki-Seite. Server Component: lädt
 * `GET /api/pages/:id` (Session-Cookie durchgereicht), rendert die Seite als
 * `.main.card` samt rechter Info-Leiste. 404 der API → Next `notFound()`;
 * jeder andere Fehler → Fehlerkarte mit Retry (nie eine leere Seite ohne
 * Erklärung, Plan Global Constraints Abschnitt 9).
 *
 * `params.pageId` ist noch URL-kodiert (Next dekodiert Dynamic-Segment-Params
 * NICHT automatisch, s. lib/urls.ts) — zur Anzeige dekodieren und für den
 * API-Aufruf wieder als ein Segment kodieren (`encodeURIComponent`).
 *
 * Parallel zum Seiteninhalt wird `GET /api/pages/:id/graph?depth=1` für den
 * Mini-Graph der Rail geladen (Phase 3b Task 6) — bewusst FEHLER-TOLERANT
 * (`.catch(() => null)`), denn Lesen fällt nie aus: ein Graph-Fehler darf die
 * sonst funktionierende Leseansicht nicht in die Fehlerkarte reißen. Nur der
 * Haupt-`apiFetch` bestimmt den Fehler-/404-Zweig unten.
 *
 * Ebenso parallel und ebenso fehlertolerant wird `GET
 * /api/spaces/:space/metadata-schema` geladen (Metadaten-Feature M2): die
 * Rail rendert daraus zusätzliche, schema-getriebene Metadaten-Felder (s.
 * `lib/metadata-view.ts#buildMetadataView`) — `null` bei Fehler/keinem
 * Schema, dann zeigt die Rail einfach keinen zusätzlichen Block (Fail-Soft,
 * dieselbe Philosophie wie beim Mini-Graph).
 *
 * Redirect auf die kanonische Id (Phase 3.1, „Stabile Seiten-Id + Backfill +
 * Redirect"): `GET /api/pages/:id` antwortet statt der Seite mit `{redirectTo}`
 * (200, s. `apps/api/src/routes/pages.ts#lookupRedirectTarget`), wenn `pageId`
 * eine ALTE `path:`-Fallback-Id ist, die seit einem Backfill-Lauf keine Zeile
 * mehr trifft — die Seite existiert weiterhin, nur unter einer neuen,
 * stabilen Id. In diesem Fall folgt diese Server Component per
 * `next/navigation#redirect` auf die kanonische URL (`wikiPageHref`), damit
 * sich die vom Nutzer gesehene Browser-URL aktualisiert (ein reiner
 * HTTP-Redirect der internen API würde `apiFetch` transparent folgen, ohne
 * dass sich die `/wiki/…`-URL im Browser ändert — alte Lesezeichen blieben
 * sonst dauerhaft auf der alten URL). `redirect()` MUSS außerhalb des
 * try/catch unten aufgerufen werden: sein interner (Next-eigener) Wurf darf
 * nicht vom generischen `catch (err)` als „Server nicht erreichbar" behandelt
 * werden.
 */
export default async function WikiPage({ params }: PageProps) {
  const { space: rawSpace, pageId: rawPageId } = await params
  const spaceId = decodeRouteParam(rawSpace)
  const pageId = decodeRouteParam(rawPageId)

  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString() || undefined
  const { t, locale } = await getT()

  let data: PageData | { redirectTo: string }
  let miniGraph: GraphData | null
  let metadataSchema: MetadataSchema | null
  try {
    ;[data, miniGraph, metadataSchema] = await Promise.all([
      apiFetch<PageData | { redirectTo: string }>(`/api/pages/${encodeURIComponent(pageId)}`, {
        cookie: cookieHeader,
      }),
      apiFetch<GraphData>(`/api/pages/${encodeURIComponent(pageId)}/graph?depth=1`, { cookie: cookieHeader }).catch(
        () => null,
      ),
      apiFetch<MetadataSchema>(`/api/spaces/${encodeURIComponent(spaceId)}/metadata-schema`, {
        cookie: cookieHeader,
      }).catch(() => null),
    ])
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    return (
      <main className="main" style={{ padding: 'var(--space-6) var(--space-7)' }}>
        <div className="callout error" role="alert">
          <p>{t('read.loadError')}</p>
          <div className="btn-row">
            <a href={wikiPageHref(spaceId, pageId)}>{t('read.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  if ('redirectTo' in data) {
    redirect(wikiPageHref(spaceId, data.redirectTo))
  }

  return (
    <>
      <PageView data={data} />
      <Rail
        headings={data.headings}
        tags={data.tags}
        relations={data.relations}
        space={data.space}
        status={pageStatusLabel(t, data.archived, data.workflow?.state ?? null)}
        updatedAtLabel={formatUpdatedAt(data.updatedAt, locale)}
        miniGraph={miniGraph}
        pageId={data.id}
        metadataSchema={metadataSchema}
        metadata={data.metadata}
      />
    </>
  )
}
