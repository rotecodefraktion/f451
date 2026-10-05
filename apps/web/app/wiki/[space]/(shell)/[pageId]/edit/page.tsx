import type { MetadataSchema } from '@f451/markdown'
import { cookies } from 'next/headers'
import { EditorRoot } from '../../../../../../components/editor/editor-root'
import type { PageData } from '../../../../../../components/page-view'
import { ApiError, apiFetch } from '../../../../../../lib/api'
import { getFrame } from '../../../../../../lib/resolved-theme'
import { decodeRouteParam, wikiPageEditHref, wikiPageHref } from '../../../../../../lib/urls'

interface EditPageProps {
  params: Promise<{ space: string; pageId: string }>
}

/**
 * Grobe, menschenlesbare Näherung an den Seitentitel AUS DER ID (Phase 2d
 * Task 6-Fund, s. Kommentar unten) — NICHT der endgültige Titel, nur ein
 * Platzhalter für die Statuszeilen-Breadcrumb, bis `<EditorRoot>` den echten
 * Draft-Inhalt lädt. `path:<space>/<Verzeichnisse>/<datei>.md`-Fallback-Ids
 * (s. `lib/urls.ts`-Modulkommentar): letztes NICHT-`index.md`-Segment
 * humanisiert (Bindestriche/Unterstriche → Leerzeichen), sonst die rohe Id.
 */
function fallbackTitleFromPageId(pageId: string): string {
  const withoutPrefix = pageId.startsWith('path:') ? pageId.slice('path:'.length) : pageId
  const segments = withoutPrefix.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? withoutPrefix
  const meaningful = last.replace(/\.[^./]+$/, '') === 'index' ? (segments[segments.length - 2] ?? last) : last
  const humanized = meaningful.replace(/\.[^./]+$/, '').replace(/[-_]+/g, ' ').trim()
  return humanized.length > 0 ? humanized : pageId
}

/**
 * Bearbeiten-Einstieg einer Wiki-Seite. Server Component, gleiches
 * Cookie-Forwarding-Muster wie `[pageId]/page.tsx`: die Session ist bereits
 * durch das Eltern-Layout (`wiki/layout.tsx`) geprüft, hier reicht der
 * Cookie-Header unverändert an `apiFetch` durch. Lädt nur Titel/Breadcrumb-
 * Grunddaten via `GET /api/pages/:id` (main-Ref) — der eigentliche
 * Draft-Inhalt kommt aus `POST /api/pages/:id/draft`, den `<EditorRoot>`
 * client-seitig beim Mount lädt (Draft-API ist ausschließlich über
 * Client-Fetches erreichbar, s. `lib/editor/client-api.ts`).
 *
 * `params.pageId`/`params.space` sind noch URL-kodiert (s. `lib/urls.ts`) —
 * vor Anzeige/API-Aufruf dekodieren, für den API-Pfad wieder als ein
 * Segment kodieren.
 *
 * Bugfix (Phase 2d Task 6, Dev-Smoke „Neue Seite → Editor" real beobachtet):
 * `GET /api/pages/:id` liest AUSSCHLIESSLICH `ref='main'` (Modul-Kommentar
 * `apps/api/src/routes/pages.ts`) — eine frisch über `POST /api/pages`
 * angelegte Seite (Task 5) existiert bis zu ihrem ersten Release NUR als
 * `ref='draft'`-Zeile und hat deshalb hier IMMER einen 404, obwohl sie laut
 * API-README „sofort über den Editor-Pfad erreichbar" ist. Ein 404 bedeutete
 * bislang zwingend `notFound()` — das hätte den kompletten Neue-Seite-Flow
 * lahmgelegt. Der 404-Fall wird deshalb NICHT mehr sofort als „Seite
 * existiert nicht" gewertet: `<EditorRoot>` versucht trotzdem zu laden (es
 * nutzt intern `resolveWriteContext`, das für unbekannte Ids ZUSÄTZLICH auf
 * eine vorhandene Draft-Zeile zurückfällt, s. API-README „POST /api/pages") —
 * ist die Id wirklich unbekannt (kein Draft, kein Schreibrecht), zeigt
 * `<EditorRoot>` selbst seine Fehlerkarte, statt einer harten 404-Seite ohne
 * Erklärung. Der Titel ist in diesem Zweig nur eine Näherung (s.
 * {@link fallbackTitleFromPageId}) — verbindlich wird er erst nach dem
 * ersten Release, wenn diese Route wieder den regulären Pfad nimmt.
 *
 * Jeder andere Fehler (Netzwerk/502/…) → Fehlerkarte mit Retry-Link auf die
 * Edit-Route selbst (nie eine leere Seite ohne Erklärung). KEIN `rail`-Aside
 * — die rechte Info-Leiste ist ein Lese-Feature (ToC/Tags/Relationen), im
 * Editor nicht Teil dieses Tasks.
 *
 * Seit Metadaten-Feature M3 lädt diese Route ZUSÄTZLICH `GET
 * /api/spaces/:space/metadata-schema` (Muster `[pageId]/page.tsx` aus M2) und
 * reicht es an `<EditorRoot>` durch — `<MetadataPanel>` rendert daraus das
 * schema-getriebene Erfass-Formular. Der Fetch startet PARALLEL zum
 * Titel-Request oben (kein zusätzlicher sequentieller Roundtrip) und ist
 * bewusst FEHLER-TOLERANT (`.catch(() => null)`, identisch zu M2): ein
 * Schema-Fehler darf den Editor nicht blockieren, `<MetadataPanel>` zeigt
 * dann einfach kein Formular (Fail-Soft, s. dessen Kopfkommentar).
 */
export default async function EditPage({ params }: EditPageProps) {
  const { space: rawSpace, pageId: rawPageId } = await params
  const spaceId = decodeRouteParam(rawSpace)
  const pageId = decodeRouteParam(rawPageId)

  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString() || undefined

  const metadataSchemaPromise = apiFetch<MetadataSchema>(
    `/api/spaces/${encodeURIComponent(spaceId)}/metadata-schema`,
    { cookie: cookieHeader },
  ).catch(() => null)

  let title: string
  try {
    const data = await apiFetch<PageData>(`/api/pages/${encodeURIComponent(pageId)}`, {
      cookie: cookieHeader,
    })
    title = data.title
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      title = fallbackTitleFromPageId(pageId)
    } else {
      return (
        <main className="main" style={{ padding: 'var(--space-6) var(--space-7)' }}>
          <div className="callout error" role="alert">
            <p>Die Seite konnte nicht geladen werden — der Server ist nicht erreichbar.</p>
            <div className="btn-row">
              <a href={wikiPageEditHref(spaceId, pageId)}>Erneut versuchen</a>
              <a href={wikiPageHref(spaceId, pageId)}>Zur Leseansicht zurückkehren</a>
            </div>
          </div>
        </main>
      )
    }
  }

  const metadataSchema = await metadataSchemaPromise
  // Frame switch `--status-bar: bottom` (f451#60): save state at the foot of `.main`.
  const { statusBar } = await getFrame({ hasTree: true })

  return (
    <main className="main">
      <EditorRoot
        pageId={pageId}
        space={spaceId}
        title={title}
        metadataSchema={metadataSchema}
        statusBarBottom={statusBar}
      />
    </main>
  )
}
