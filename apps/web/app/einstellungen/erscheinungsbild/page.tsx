import { cookies } from 'next/headers'
import { Attribution } from '../../../components/attribution'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { AccountMenu } from '../../../components/account-menu'
import { ScopeSelector } from '../../../components/theme-editor/scope-selector'
import { ThemeEditor } from '../../../components/theme-editor/theme-editor'
import { ThresholdStrip } from '../../../components/theme-editor/threshold-strip'
import { apiFetch } from '../../../lib/api'
import { getT } from '../../../lib/i18n/server'
import { getMe } from '../../../lib/session'
import type { EditorData } from '../../../lib/theme-editor'
import { editorApiPath, pickScope, type ThemeScopes } from '../../../lib/theme-editor-view'
import { Shell } from '../../shell'

/**
 * Appearance: the theme editor of the instance or of one space (July spec
 * `2026-07-26-themefaehigkeit-design.md`, chapter "Bedienung"). Frame as in
 * `app/einstellungen/verbindungen/page.tsx` (session gate via `getMe`,
 * `<Shell>` with the settings navigation, `<main className="main">`).
 *
 * The scope comes from `?scope=instance|space:<id>`; without one (or with one
 * the caller cannot see) the instance opens, else the first readable space.
 * Both requests carry the session cookie; the editor island gets the answer
 * of `GET /api/theme/editor` as is.
 */
export default async function ErscheinungsbildPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>
}) {
  const { scope: scopeQuery } = await searchParams
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()
  const cookie = cookieHeader || undefined
  const { t } = await getT()

  // An unreachable API is NOT a reason for a login redirect (the session may
  // be valid) — an error banner with a retry link instead, as on Connections.
  let me: Awaited<ReturnType<typeof getMe>>
  try {
    me = await getMe(cookie)
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

  let scopes: ThemeScopes | null = null
  try {
    scopes = await apiFetch<ThemeScopes>('/api/theme/scopes', { cookie })
  } catch {
    scopes = null
  }
  const scope = scopes ? pickScope(scopeQuery, scopes) : null

  let data: EditorData | null = null
  if (scope) {
    try {
      data = await apiFetch<EditorData>(editorApiPath(scope), { cookie })
    } catch {
      data = null
    }
  }

  let content: ReactNode
  if (!scopes) {
    content = (
      <div className="callout error" role="alert">
        <span>{t('settings.appearance.loadError')}</span>
        <a href="/einstellungen/erscheinungsbild">{t('settings.retry')}</a>
      </div>
    )
  } else if (!scope) {
    content = (
      <div className="empty">
        <p>{t('settings.appearance.noScopes')}</p>
      </div>
    )
  } else if (!data) {
    content = (
      <>
        <ScopeSelector scopes={scopes} current={scope} />
        <div className="callout error" role="alert">
          <span>{t('settings.appearance.loadError')}</span>
        </div>
      </>
    )
  } else {
    content = (
      <ThemeEditor
        scopes={scopes}
        data={data}
        thresholdStrip={
          <ThresholdStrip data={data} canWriteInstance={scopes.instance.canWrite} scopeKind={data.scope.kind} />
        }
      />
    )
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
      <Attribution />
    </nav>
  )

  return (
    <Shell
      space={t('settings.appearance.shellSpace')}
      sidebar={sidebar}
      avatar={<AccountMenu displayName={me.displayName} />}
    >
      <main className="main doc-pad">
        <h1 className="te-heading">{t('settings.appearance.heading')}</h1>
        <p className="te-intro">{t('settings.appearance.intro')}</p>
        {content}
      </main>
    </Shell>
  )
}
