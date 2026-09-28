import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import type { MetadataSchema } from '@f451/markdown'
import { MetadataSchemaEditor } from '../../../../../components/editor/metadata-schema-editor'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getT } from '../../../../../lib/i18n/server'
import { apiSpaceMetadataSchemaPath, decodeRouteParam } from '../../../../../lib/urls'

interface SchemaPageProps {
  params: Promise<{ space: string }>
}

/**
 * Metadaten-Schema-Editor-Seite (Metadaten-Feature M4) — lädt den aktuellen
 * Schema-Stand server-seitig (`GET /api/spaces/:space/metadata-schema`,
 * Muster `report/page.tsx`) und reicht ihn als Ausgangsstand an die
 * Client-Insel `MetadataSchemaEditor` weiter, die Bearbeiten/Speichern
 * (`PUT`) übernimmt. Unbekannter/nicht lesbarer Space → 404 (dieselbe
 * Antwort für beide Fälle, kein Existenz-Orakel — s. `routes/metadata-schema.ts`).
 */
export default async function SchemaPage({ params }: SchemaPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined
  const { t } = await getT()

  let schema: MetadataSchema
  try {
    schema = await apiFetch<MetadataSchema>(apiSpaceMetadataSchemaPath(spaceId), { cookie: cookieHeader })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    throw err
  }

  return (
    <main className="main full doc-pad">
      <h1 style={{ marginTop: 0 }}>{t('schema.pageTitle')}</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>{t('schema.pageIntro')}</p>
      <MetadataSchemaEditor space={spaceId} initialSchema={schema} />
    </main>
  )
}
