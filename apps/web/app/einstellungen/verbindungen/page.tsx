import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AccountMenu } from '../../../components/account-menu'
import { ApiTokensPanel, type ApiTokenSummary } from '../../../components/api-tokens-panel'
import { DisconnectButton } from '../../../components/disconnect-button'
import { apiFetch } from '../../../lib/api'
import { getT } from '../../../lib/i18n/server'
import { getMe } from '../../../lib/session'
import { Shell } from '../../shell'

const PROVIDERS: Array<{ id: 'forgejo' | 'github'; label: string }> = [
  { id: 'forgejo', label: 'Forgejo' },
  { id: 'github', label: 'GitHub' },
]

/**
 * Verbindungen-Verwaltung: geschützte Seite (Session-Gate über `getMe`).
 * Connect ist ein einfacher Link auf `/auth/connect/:provider` (löst den
 * OAuth-Redirect aus); Disconnect ist ein Client-Button mit DELETE-Fetch.
 */
export default async function VerbindungenPage({
  searchParams,
}: {
  searchParams: Promise<{ verbindung?: string }>
}) {
  const { verbindung } = await searchParams
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()
  const { t } = await getT()

  // API nicht erreichbar (Netzwerk-/Serverfehler, kein 401) → Fehlerbanner mit
  // Retry statt Login-Redirect: ein automatischer Redirect wäre hier irreführend,
  // da die Session ggf. gültig ist und der Fehler nur beim API-Aufruf liegt
  // (Plan Global Constraints Abschnitt 9).
  let me: Awaited<ReturnType<typeof getMe>>
  try {
    me = await getMe(cookieHeader || undefined)
  } catch {
    return (
      <main className="login-page">
        <div className="login-card card">
          <div className="callout error" role="alert">
            <span>{t('settings.serverUnreachable')}</span>
            <a href="/einstellungen/verbindungen">{t('settings.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  if (!me) {
    redirect('/?next=/einstellungen/verbindungen')
  }

  // Persönliche API-Tokens (MCP-Phase 0): serverseitig vorgeladen (dieselbe
  // Session-Cookie-Weiterreichung wie `getMe` oben), damit die Liste ohne
  // Ladeflackern erscheint. Ein Fehler hier ist NICHT fatal für die ganze
  // Seite (anders als ein fehlender `me`) — die Verbindungen bleiben nutzbar,
  // nur die Token-Sektion startet dann leer (Client-Aktionen zeigen ihre
  // eigenen Fehler, s. `ApiTokensPanel`).
  let initialTokens: ApiTokenSummary[] = []
  try {
    initialTokens = await apiFetch<ApiTokenSummary[]>('/api/tokens', { cookie: cookieHeader || undefined })
  } catch {
    initialTokens = []
  }

  const sidebar = (
    <nav className="tree" aria-label={t('settings.connections.navAriaLabel')}>
      <div className="head">
        <span className="sq">E</span>
        <div>
          <b>{t('settings.connections.navHeading')}</b>
          <small>{t('settings.connections.navSub')}</small>
        </div>
      </div>
      <div className="settings-nav">
        <a href="/einstellungen/verbindungen" className="settings-nav-item active" aria-current="page">
          {t('settings.connections.navItem')}
        </a>
      </div>
    </nav>
  )

  return (
    <Shell space={t('settings.connections.shellSpace')} sidebar={sidebar} avatar={<AccountMenu displayName={me.displayName} />}>
      {/* `.doc-pad` (60-chrome-raster.css) statt des Inline-Stils
          `padding: var(--space-6) var(--space-7)` — die Werte sind wörtlich
          gleich (`--content-pad-x` IST `var(--space-7)`). H4 hatte den Wechsel
          zurückgenommen, weil `.doc-pad` mit `margin-inline: auto` an einem
          Gitterkind das Strecken aufhob (gemessen: 890 → 596 px). H1 hat den
          Fehler in der Klasse behoben (`width: 100%`, s. dortige Begründung);
          damit ist der Wechsel wieder wertgleich, und Teilschritt I hat ihn
          vollzogen. */}
      <main className="main doc-pad">
        <h1
          style={{
            margin: '0 0 var(--space-2)',
            fontSize: 'var(--text-2xl)',
            fontWeight: 'var(--weight-strong)',
            letterSpacing: '-0.02em',
          }}
        >
          {t('settings.connections.heading')}
        </h1>
        <p style={{ color: 'var(--color-text-muted)', maxWidth: '72ch', margin: '0 0 var(--space-2)' }}>
          {t('settings.connections.intro')}
        </p>

        {/* Rücksprung der Kontoverknüpfung gescheitert — die API leitet mit
            `?verbindung=` hierher, statt JSON zu zeigen. */}
        {verbindung === 'abgelaufen' || verbindung === 'fehlgeschlagen' ? (
          <div className="callout warn" role="alert">
            <span>
              {verbindung === 'abgelaufen'
                ? t('settings.connections.connectExpired')
                : t('settings.connections.connectFailed')}
            </span>
          </div>
        ) : null}

        <div className="conn-list">
          {PROVIDERS.map((provider) => {
            const connected = me.connections[provider.id]
            const expired = connected && me.expiredConnections[provider.id]
            return (
              <div className="card conn-row" key={provider.id}>
                <div className="conn-info">
                  <b>{provider.label}</b>
                  {expired ? (
                    <span className="chip warn">{t('settings.connections.expired')}</span>
                  ) : (
                    <span className={connected ? 'chip ok' : 'chip neutral'}>
                      {connected ? t('settings.connections.connected') : t('settings.connections.notConnected')}
                    </span>
                  )}
                  {expired && (
                    <small>
                      {t('settings.connections.expiredHint', { label: provider.label })}
                    </small>
                  )}
                </div>
                {expired ? (
                  <div className="btn-row">
                    {/* Der Connect-Flow ersetzt die bestehende Verknüpfung (Upsert). */}
                    <a className="btn primary" href={`/auth/connect/${provider.id}`}>
                      {t('settings.connections.reconnect')}
                    </a>
                    <DisconnectButton provider={provider.id} label={provider.label} />
                  </div>
                ) : connected ? (
                  <DisconnectButton provider={provider.id} label={provider.label} />
                ) : (
                  <a className="btn primary" href={`/auth/connect/${provider.id}`}>
                    {t('settings.connections.connect')}
                  </a>
                )}
              </div>
            )
          })}
        </div>

        <ApiTokensPanel initialTokens={initialTokens} />
      </main>
    </Shell>
  )
}
