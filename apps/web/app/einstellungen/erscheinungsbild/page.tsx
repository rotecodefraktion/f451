import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AccountMenu } from '../../../components/account-menu'
import { ErscheinungsbildEditor } from '../../../components/erscheinungsbild-editor'
import { baueGruppen, type Modus, type TokenGruppe } from '../../../lib/erscheinungsbild'
import { getT } from '../../../lib/i18n/server'
import { getMe } from '../../../lib/session'
import { Shell } from '../../shell'

/**
 * Erscheinungsbild: der Token-Katalog dieser Oberfläche, im Browser änderbar.
 * Aufbau wie `app/einstellungen/verbindungen/page.tsx` (Session-Gate über
 * `getMe`, `<Shell>` mit eigener Einstellungs-Navigation, `<main className="main">`).
 *
 * Der Katalog wird HIER gebaut, für beide Modi, und als Prop an die
 * Client-Insel gereicht: `baueGruppen` liest den ausgelieferten Token-Bestand
 * und hat im Browser nichts zu suchen. Die Insel importiert aus der
 * Datenschicht nur noch das Lesen/Schreiben der Überschreibungen.
 */
export default async function ErscheinungsbildPage() {
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()
  const { t } = await getT()

  // Gleiche Fehlerbehandlung wie bei den Verbindungen: ein nicht erreichbarer
  // API-Server ist KEIN Grund für einen Login-Redirect (die Session kann
  // gültig sein), sondern ein Fehlerbanner mit Wiederholen-Link.
  let me: Awaited<ReturnType<typeof getMe>>
  try {
    me = await getMe(cookieHeader || undefined)
  } catch {
    return (
      <main className="login-page">
        <div className="login-card card">
          <div className="callout error" role="alert">
            <span>{t('settings.serverUnreachable')}</span>
            <a href="/einstellungen/erscheinungsbild">{t('settings.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  if (!me) {
    redirect('/?next=/einstellungen/erscheinungsbild')
  }

  const gruppen: Record<Modus, TokenGruppe[]> = {
    light: baueGruppen('light'),
    dark: baueGruppen('dark'),
  }

  const sidebar = (
    <nav className="tree" aria-label={t('settings.appearance.navAriaLabel')}>
      <div className="head">
        <span className="sq">E</span>
        <div>
          <b>{t('settings.appearance.navHeading')}</b>
          <small>{t('settings.appearance.navSub')}</small>
        </div>
      </div>
      <div className="settings-nav">
        <a href="/einstellungen/verbindungen" className="settings-nav-item">
          {t('settings.connections.navItem')}
        </a>
        <a href="/einstellungen/erscheinungsbild" className="settings-nav-item active" aria-current="page">
          {t('settings.appearance.navItem')}
        </a>
      </div>
    </nav>
  )

  return (
    <Shell
      space={t('settings.appearance.shellSpace')}
      sidebar={sidebar}
      avatar={<AccountMenu displayName={me.displayName} />}
    >
      <main className="main doc-pad">
        <h1
          style={{
            margin: '0 0 var(--space-2)',
            fontSize: 'var(--text-2xl)',
            fontWeight: 'var(--weight-display)',
            letterSpacing: 'var(--tracking-tight)',
          }}
        >
          {t('settings.appearance.heading')}
        </h1>
        <p style={{ color: 'var(--color-text-muted)', maxWidth: 'var(--measure)', margin: '0 0 var(--space-2)' }}>
          {t('settings.appearance.intro')}
        </p>

        <ErscheinungsbildEditor gruppen={gruppen} />
      </main>
    </Shell>
  )
}
