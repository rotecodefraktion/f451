'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '../lib/i18n/provider'

export interface DisconnectButtonProps {
  provider: 'forgejo' | 'github'
  label: string
}

/**
 * Trennt eine Provider-Verknüpfung (`DELETE /auth/connect/:provider`) und
 * lädt die Server-Page danach neu (`router.refresh()`), damit der neue
 * Connect-Status aus `/api/me` sichtbar wird.
 */
export function DisconnectButton({ provider, label }: DisconnectButtonProps) {
  const { t } = useT()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function disconnect() {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch(`/auth/connect/${provider}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        })
        if (!res.ok) {
          setError(t('settings.connections.disconnectError'))
          return
        }
        router.refresh()
      } catch {
        setError(t('settings.connections.disconnectError'))
      }
    })
  }

  return (
    <div>
      <button type="button" className="btn" onClick={disconnect} disabled={pending}>
        {pending ? t('settings.connections.disconnecting') : t('settings.connections.disconnect', { label })}
      </button>
      {error ? (
        <p className="callout error tool-status" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
