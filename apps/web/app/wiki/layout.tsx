import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getT } from '../../lib/i18n/server'
import { getMe } from '../../lib/session'

/**
 * Session-Gate für den gesamten `/wiki`-Baum: ohne gültige Session geht es
 * zurück zur Login-Seite mit `next`-Rückkehrziel auf den aktuellen Pfad.
 *
 * Rendert bewusst KEINE `<Shell>` selbst: die Sidebar (Seitenbaum) kann erst
 * `[space]/layout.tsx` befüllen (dort liegen die Tree-Daten), und Next.js
 * erlaubt keinem Kind-Layout, Props in eine bereits vom Eltern-Layout
 * instanziierte Komponente nachzureichen — die Slots von `<Shell sidebar=…>`
 * müssen also am Ort ihrer Daten gefüllt werden. `[space]/layout.tsx` und
 * `wiki/page.tsx` rendern deshalb jeweils ihre eigene `<Shell>`-Instanz (mit
 * eigenem `getMe`-Aufruf für den Avatar — Next dedupliziert identische
 * `fetch`-Aufrufe innerhalb eines Request-Durchlaufs automatisch).
 */
export default async function WikiLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()

  const { t } = await getT()

  let me: Awaited<ReturnType<typeof getMe>>
  try {
    me = await getMe(cookieHeader || undefined)
  } catch {
    return (
      <main className="login-page">
        <div className="login-card card">
          <div className="callout error" role="alert">
            <span>{t('settings.serverUnreachable')}</span>
            <a href="/wiki">{t('settings.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  if (!me) {
    redirect('/?next=/wiki')
  }

  return <>{children}</>
}
