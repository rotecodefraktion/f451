import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AccountMenu } from '../../components/account-menu'
import { apiFetch } from '../../lib/api'
import { getMe } from '../../lib/session'
import { wikiSpaceHref } from '../../lib/urls'
import { Shell } from '../shell'

interface SpaceSummary {
  id: string
  name: string
  defaultLang: string
}

/**
 * `/wiki`-Übersicht: leitet auf den ersten konfigurierten Space weiter
 * (`/wiki/<space>` entscheidet dort selbst über die erste Wurzelseite). Ohne
 * Spaces (oder bei API-Fehlern) zeigt sie eine erklärende Karte statt einer
 * leeren Seite (Plan Global Constraints Abschnitt 9).
 *
 * `wiki/layout.tsx` hat die Session bereits geprüft; `getMe` wird hier erneut
 * aufgerufen, um den Avatar für die eigene `<Shell>`-Instanz zu befüllen
 * (siehe Kommentar in `wiki/layout.tsx` zur Slot-Architektur).
 */
export default async function WikiIndexPage() {
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()

  let me: Awaited<ReturnType<typeof getMe>>
  try {
    me = await getMe(cookieHeader || undefined)
  } catch {
    return <ErrorCard />
  }
  if (!me) {
    redirect('/?next=/wiki')
  }

  let spaces: SpaceSummary[]
  try {
    spaces = await apiFetch<SpaceSummary[]>('/api/spaces', { cookie: cookieHeader || undefined })
  } catch {
    return <ErrorCard avatar={<AccountMenu displayName={me.displayName} />} />
  }

  if (spaces.length > 0) {
    redirect(wikiSpaceHref(spaces[0]!.id))
  }

  // Erst die Space-Probe eben stellt fest, ob der Provider den Refresh ablehnt
  // (Issue #70) — das `me` von oben ist dafür zu früh gelesen.
  const expired = await getMe(cookieHeader || undefined)
    .then((fresh) => fresh?.expiredConnections)
    .catch(() => undefined)
  const expiredLabel = expired?.forgejo ? 'Forgejo' : expired?.github ? 'GitHub' : null

  if (expiredLabel) {
    return (
      <Shell avatar={<AccountMenu displayName={me.displayName} />}>
        <main className="main doc-pad">
          <div className="callout warn" role="alert">
            <p>
              <b>Deine {expiredLabel}-Verknüpfung ist abgelaufen.</b> Deshalb siehst du gerade keine
              Spaces. Stelle die Verknüpfung neu her, danach sind sie sofort wieder da.
            </p>
            <div className="btn-row">
              <a className="btn primary" href="/einstellungen/verbindungen">
                Zu den Verbindungen
              </a>
            </div>
          </div>
        </main>
      </Shell>
    )
  }

  return (
    <Shell avatar={<AccountMenu displayName={me.displayName} />}>
      <main className="main doc-pad">
        <h1
          style={{
            margin: '0 0 var(--space-2)',
            fontSize: 'var(--text-2xl)',
            fontWeight: 'var(--weight-strong)',
            letterSpacing: '-0.02em',
          }}
        >
          Keine Spaces verfügbar
        </h1>
        <p style={{ color: 'var(--color-text-muted)', maxWidth: '72ch', margin: 0 }}>
          Für dein Konto ist aktuell kein Space konfiguriert oder freigegeben. Wende dich an dein
          Betriebsteam oder verknüpfe unter{' '}
          <a href="/einstellungen/verbindungen">Einstellungen → Verbindungen</a> ein Git-Konto mit
          Zugriff auf ein Repository.
        </p>
      </main>
    </Shell>
  )
}

/** Fehlerbanner bei nicht erreichbarer API — mit Retry statt leerer Seite. */
function ErrorCard({ avatar }: { avatar?: ReactNode }) {
  if (!avatar) {
    return (
      <main className="login-page">
        <div className="login-card card">
          <div className="callout error" role="alert">
            <span>Der Server ist aktuell nicht erreichbar.</span>
            <a href="/wiki">Erneut versuchen</a>
          </div>
        </div>
      </main>
    )
  }
  return (
    <Shell avatar={avatar}>
      <main className="main doc-pad">
        <div className="callout error" role="alert">
          <p>Der Server ist aktuell nicht erreichbar.</p>
          <div className="btn-row">
            <a href="/wiki">Erneut versuchen</a>
          </div>
        </div>
      </main>
    </Shell>
  )
}
