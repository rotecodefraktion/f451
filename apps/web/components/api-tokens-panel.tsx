'use client'

import { useEffect, useState, useTransition } from 'react'
import { useT } from '../lib/i18n/provider'
import type { Locale, T } from '../lib/i18n/types'

export interface ApiTokenSummary {
  id: string
  label: string
  scope: 'read' | 'write'
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revoked: boolean
}

interface CreatedToken {
  id: string
  label: string
  scope: 'read' | 'write'
  expiresAt: string | null
  token: string
}

export interface ApiTokensPanelProps {
  initialTokens: ApiTokenSummary[]
}

/** `timeZone` ist bis zur Hydrierung fest UTC: Der Server (Container, UTC)
 *  und der Browser (Ortszeit) formatierten sonst unterschiedlich, und React
 *  meldete einen Hydrierungsfehler (#418). Danach gilt die Ortszeit. */
function formatDate(iso: string | null, locale: Locale, t: T, timeZone: string | undefined): string {
  if (!iso) return t('settings.apiTokens.neverValue')
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone })
}

/**
 * Persönliche API-Token-Verwaltung (MCP-Phase 0) — nutzt die per Next-Rewrite
 * (`next.config.ts`, `/api/:path*`) durchgereichten `/api/tokens`-Routen der
 * API (Muster `components/disconnect-button.tsx`: direkter `fetch` mit
 * `credentials: 'same-origin'`, kein eigener Web-Proxy-Layer nötig).
 *
 * Der Klartext eines neu erzeugten Tokens (`token`-Feld der POST-Antwort)
 * wird NUR lokal im Component-State gehalten und NIE persistiert — nach
 * einem Reload ist er unwiederbringlich weg (das ist Absicht, s. API-Doku:
 * die DB speichert nur den Hash).
 */
export function ApiTokensPanel({ initialTokens }: ApiTokensPanelProps) {
  const { t, locale } = useT()
  const [tokens, setTokens] = useState<ApiTokenSummary[]>(initialTokens)
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('read')
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState(false)
  const [hydriert, setHydriert] = useState(false)
  useEffect(() => setHydriert(true), [])
  const zeitzone = hydriert ? undefined : 'UTC'
  const [pending, startTransition] = useTransition()

  function createToken() {
    setError(null)
    const trimmed = label.trim()
    if (!trimmed) {
      setError(t('settings.apiTokens.labelRequired'))
      return
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/tokens', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: trimmed, scope }),
        })
        if (!res.ok) {
          setError(t('settings.apiTokens.createError'))
          return
        }
        const body = (await res.json()) as CreatedToken
        setCreated(body)
        setCopyHint(false)
        setLabel('')
        setTokens((prev) => [
          {
            id: body.id,
            label: body.label,
            scope: body.scope,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            expiresAt: body.expiresAt,
            revoked: false,
          },
          ...prev,
        ])
      } catch {
        setError(t('settings.apiTokens.createError'))
      }
    })
  }

  function revokeToken(id: string) {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE', credentials: 'same-origin' })
        if (!res.ok) {
          setError(t('settings.apiTokens.revokeError'))
          return
        }
        setTokens((prev) => prev.map((item) => (item.id === id ? { ...item, revoked: true } : item)))
      } catch {
        setError(t('settings.apiTokens.revokeError'))
      }
    })
  }

  async function copyCreatedToken() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.token)
      setCopyHint(true)
    } catch {
      // Clipboard-API kann in unsicheren Kontexten fehlen — kein Hard-Fail,
      // der Klartext steht ja ohnehin sichtbar im Reveal-Kasten unten.
    }
  }

  return (
    <section className="token-panel">
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-strong)', margin: '0 0 var(--space-2)' }}>
        {t('settings.apiTokens.heading')}
      </h2>
      <p style={{ color: 'var(--color-text-muted)', maxWidth: '72ch', margin: '0 0 var(--space-4)' }}>
        {t('settings.apiTokens.introPre')}
        <strong>{t('settings.apiTokens.introStrong')}</strong>
        {t('settings.apiTokens.introPost')}
      </p>

      {created ? (
        <div className="card token-reveal">
          <p className="token-reveal-hint">
            {t('settings.apiTokens.revealHintPre')}
            <strong>{t('settings.apiTokens.revealHintStrong')}</strong>
            {t('settings.apiTokens.revealHintPost')}
          </p>
          <code className="token-reveal-value">{created.token}</code>
          <div className="token-reveal-actions">
            <button type="button" className="btn primary" onClick={copyCreatedToken}>
              {copyHint ? t('settings.apiTokens.copied') : t('settings.apiTokens.copyToClipboard')}
            </button>
            <button type="button" className="btn" onClick={() => setCreated(null)}>
              {t('settings.apiTokens.close')}
            </button>
          </div>
        </div>
      ) : null}

      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault()
          createToken()
        }}
      >
        <div className="mf-field">
          <label htmlFor="token-label">{t('settings.apiTokens.labelFieldLabel')}</label>
          <input
            id="token-label"
            className="mf-input"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('settings.apiTokens.labelPlaceholder')}
            autoComplete="off"
            disabled={pending}
          />
        </div>
        <div className="mf-field">
          <label htmlFor="token-scope">{t('settings.apiTokens.scopeFieldLabel')}</label>
          <select
            id="token-scope"
            className="mf-input"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'read' | 'write')}
            disabled={pending}
          >
            <option value="read">{t('settings.apiTokens.scopeReadOnly')}</option>
            <option value="write">{t('settings.apiTokens.scopeWriteOption')}</option>
          </select>
        </div>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? t('settings.apiTokens.creating') : t('settings.apiTokens.createButton')}
        </button>
      </form>
      {error ? (
        <p className="callout error tool-status" role="alert">
          {error}
        </p>
      ) : null}

      <div className="conn-list token-list">
        {tokens.length === 0 ? (
          // Leerzustand-Baustein (43-flaeche.css) statt eines nackten Satzes
          // in Grauton: ein leerer Bereich soll erkennbar leer sein.
          <div className="empty">
            <p>{t('settings.apiTokens.emptyList')}</p>
          </div>
        ) : (
          tokens.map((tok) => (
            <div className="card conn-row" key={tok.id}>
              <div className="conn-info">
                <b>{tok.label}</b>
                <span className={tok.scope === 'write' ? 'chip ok' : 'chip neutral'}>
                  {tok.scope === 'write' ? t('settings.apiTokens.scopeWritePill') : t('settings.apiTokens.scopeReadOnly')}
                </span>
                {tok.revoked ? <span className="chip neutral">{t('settings.apiTokens.revokedStatus')}</span> : null}
                <small>
                  {t('settings.apiTokens.metaLine', {
                    createdAt: formatDate(tok.createdAt, locale, t, zeitzone),
                    lastUsedAt: formatDate(tok.lastUsedAt, locale, t, zeitzone),
                    expiresAt: formatDate(tok.expiresAt, locale, t, zeitzone),
                  })}
                </small>
              </div>
              {tok.revoked ? null : (
                <button type="button" className="btn" onClick={() => revokeToken(tok.id)} disabled={pending}>
                  {t('settings.apiTokens.revokeButton')}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
