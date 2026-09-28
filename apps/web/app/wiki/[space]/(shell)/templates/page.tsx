import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { TemplatesManager } from '../../../../../components/editor/templates-manager'
import { ApiError, apiFetch } from '../../../../../lib/api'
import type { TemplateSummary } from '../../../../../lib/editor/client-api'
import { getT } from '../../../../../lib/i18n/server'
import { apiSpaceTemplatesPath, decodeRouteParam } from '../../../../../lib/urls'

interface TemplatesPageProps {
  params: Promise<{ space: string }>
}

/**
 * Vorlagen-Pflege-Seite (Werkzeuge-Bereich „Vorlagen") — lädt die Vorlagen-
 * Liste server-seitig (`GET /api/spaces/:space/templates`, Muster
 * `report/page.tsx`/`schema/page.tsx`) und reicht sie als Ausgangsstand an
 * die Client-Insel {@link TemplatesManager} weiter, die Umbenennen/Inhalt
 * bearbeiten/Löschen (Space-Vorlagen) übernimmt. Globale Vorlagen sind reine
 * Anzeige (schreibgeschützt, s. `apps/api/src/routes/templates.ts`).
 * Unbekannter/nicht lesbarer Space → 404 (dieselbe Antwort für beide Fälle,
 * kein Existenz-Orakel).
 */
export default async function TemplatesPage({ params }: TemplatesPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined
  const { t } = await getT()

  let templates: TemplateSummary[]
  try {
    templates = await apiFetch<TemplateSummary[]>(apiSpaceTemplatesPath(spaceId), { cookie: cookieHeader })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    throw err
  }

  return (
    <main className="main full doc-pad">
      <h1 style={{ marginTop: 0 }}>{t('templates.pageTitle')}</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        {t('templates.intro1')}<code>_templates/</code>{t('templates.intro2')}<code>main</code>{t('templates.intro3')}
      </p>
      <TemplatesManager space={spaceId} initialTemplates={templates} />
    </main>
  )
}
