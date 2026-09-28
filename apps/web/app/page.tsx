import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getT } from '../lib/i18n/server'
import { getMe } from '../lib/session'

interface HomeProps {
  searchParams: Promise<{ next?: string; anmeldung?: string }>
}

/**
 * Leichte clientseitige Vorprüfung des `next`-Rückkehrziels (nur eine
 * einzelne, lokale Pfad-Angabe zulassen) — der maßgebliche Schutz gegen
 * offene Redirects sitzt serverseitig in `sanitizeNext` (apps/api/src/auth/oidc.ts).
 */
function safeNext(raw: string | undefined): string {
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return '/wiki'
  return raw
}

/**
 * Login-Seite: einzige ungeschützte Route. Zeigt eine zentrierte Karte mit
 * Login-Button (Redirect auf `/auth/login?next=…`); wer bereits eine gültige
 * Session hat, wird direkt zu `/wiki` weitergeleitet.
 */
export default async function Home({ searchParams }: HomeProps) {
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()
  const { next, anmeldung } = await searchParams
  const target = safeNext(next)

  // API nicht erreichbar (Netzwerk-/Serverfehler, kein 401) → Fehlerbanner mit
  // Retry statt einer abstürzenden Seite (Plan Global Constraints Abschnitt 9).
  // Ein 401 liefert `getMe` bereits als `null` zurück, siehe lib/session.ts.
  let me: Awaited<ReturnType<typeof getMe>> = null
  let loadError = false
  try {
    me = await getMe(cookieHeader || undefined)
  } catch {
    loadError = true
  }

  if (me) {
    redirect('/wiki')
  }

  const loginHref = `/auth/login?next=${encodeURIComponent(target)}`
  const retryHref = `/?next=${encodeURIComponent(target)}`
  const { t } = await getT()

  return (
    <main className="login-page">
      <div className="login-card card">
        <span className="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M6 3h13v3H10v4h7v3h-7v8H6z" fill="currentColor" />
          </svg>
        </span>
        <span className="brandline">f451</span>
        <h1>{t('settings.login.heading')}</h1>
        <p className="lede">{t('settings.login.lede')}</p>
        {anmeldung === 'abgelaufen' || anmeldung === 'fehlgeschlagen' ? (
          <div className="callout warn" role="alert">
            <span>{anmeldung === 'abgelaufen' ? t('settings.login.expired') : t('settings.login.failed')}</span>
          </div>
        ) : null}
        {loadError ? (
          <div className="callout error" role="alert">
            <span>{t('settings.serverUnreachable')}</span>
            <a href={retryHref}>{t('settings.retry')}</a>
          </div>
        ) : null}
        <a className="btn primary login-btn" href={loginHref}>
          {t('settings.login.button')}
        </a>
        <p className="foot">{t('settings.login.foot')}</p>
      </div>
    </main>
  )
}
