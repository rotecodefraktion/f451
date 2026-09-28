import { cookies } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { describeBrokenEntry, type BrokenLinksReportRow } from '../../../../../lib/broken-links'
import { getT } from '../../../../../lib/i18n/server'
import { apiSpaceBrokenLinksPath, decodeRouteParam, wikiPageHref } from '../../../../../lib/urls'

interface ReportPageProps {
  params: Promise<{ space: string }>
}

/**
 * Space-weiter Verweis-Report (Phase 3a): listet alle Seiten mit nicht
 * auflösbaren Verweisen/Beziehungen (Spec §5: „Report pro Seite und pro
 * Space — Feature, nicht Fehler"). Server Component — die Daten kommen per
 * `apiFetch` aus `GET /api/spaces/:space/broken-links`; unbekannter bzw.
 * nicht zugänglicher Space → 404 (die API antwortet für beide Fälle
 * identisch, kein Existenz-Orakel).
 */
export default async function ReportPage({ params }: ReportPageProps) {
  const { space: rawSpaceId } = await params
  const spaceId = decodeRouteParam(rawSpaceId)
  const cookieHeader = (await cookies()).toString() || undefined
  const { t } = await getT()

  let report: BrokenLinksReportRow[]
  try {
    report = await apiFetch<BrokenLinksReportRow[]>(apiSpaceBrokenLinksPath(spaceId), {
      cookie: cookieHeader,
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    throw err
  }

  return (
    <main className="main full doc-pad">
      <h1 style={{ marginTop: 0 }}>{t('settings.report.heading')}</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>{t('settings.report.intro')}</p>
      {report.length === 0 ? (
        // Leerzustand-Baustein (43-flaeche.css): die leere Berichtsliste ist
        // der Normalfall und soll als solcher erkennbar sein statt als ein
        // Satz, der im Fließtext untergeht.
        <div className="empty" role="status">
          <p>{t('settings.report.allResolvable')}</p>
        </div>
      ) : (
        report.map((row) => (
          <section key={row.pageId} style={{ marginBottom: 'var(--space-5)' }}>
            <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>
              <Link href={wikiPageHref(spaceId, row.pageId)}>{row.title}</Link>{' '}
              <code style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                {row.path}
              </code>
            </h2>
            <ul className="notice-list" style={{ margin: 0 }}>
              {row.entries.map((entry, i) => (
                <li key={i}>
                  <code>{entry.rawTarget}</code> — {describeBrokenEntry(entry)}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  )
}
