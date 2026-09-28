import { describe, expect, it, vi } from 'vitest'

const { cookiesMock, headersMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  headersMock: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: cookiesMock,
  headers: headersMock,
}))

import { getLocale, parseAcceptLanguage } from './server.js'
import { LANG_COOKIE } from './types.js'

/** Minimaler Stand-in für Next' `ReadonlyRequestCookies` (nur `.get`, s. `getLocale`). */
function fakeCookieStore(value: string | undefined) {
  return { get: (name: string) => (name === LANG_COOKIE && value !== undefined ? { name, value } : undefined) }
}

/** Minimaler Stand-in für Next' `Headers` (nur `.get`, s. `getLocale`). */
function fakeHeaders(acceptLanguage: string | null) {
  return { get: (name: string) => (name.toLowerCase() === 'accept-language' ? acceptLanguage : null) }
}

describe('getLocale', () => {
  it('Cookie gewinnt vor Accept-Language', async () => {
    cookiesMock.mockResolvedValue(fakeCookieStore('en'))
    headersMock.mockResolvedValue(fakeHeaders('de-DE,de;q=0.9'))
    await expect(getLocale()).resolves.toBe('en')
  })

  it('fällt ohne Cookie auf Accept-Language zurück', async () => {
    cookiesMock.mockResolvedValue(fakeCookieStore(undefined))
    headersMock.mockResolvedValue(fakeHeaders('en-US,en;q=0.9,de;q=0.8'))
    await expect(getLocale()).resolves.toBe('en')
  })

  it('fällt ohne Cookie und ohne erkennbares Accept-Language auf de zurück', async () => {
    cookiesMock.mockResolvedValue(fakeCookieStore(undefined))
    headersMock.mockResolvedValue(fakeHeaders(null))
    await expect(getLocale()).resolves.toBe('de')
  })

  it('ignoriert einen ungültigen Cookie-Wert (fällt auf Accept-Language/de zurück)', async () => {
    cookiesMock.mockResolvedValue(fakeCookieStore('fr'))
    headersMock.mockResolvedValue(fakeHeaders(null))
    await expect(getLocale()).resolves.toBe('de')
  })
})

describe('parseAcceptLanguage', () => {
  it('erkennt "de*"-Tags', () => {
    expect(parseAcceptLanguage('de-DE,de;q=0.9')).toBe('de')
  })

  it('erkennt "en*"-Tags', () => {
    expect(parseAcceptLanguage('en-GB,en;q=0.9')).toBe('en')
  })

  it('nimmt die erste erkennbare Präferenz in q-Reihenfolge', () => {
    expect(parseAcceptLanguage('fr-FR,en-US;q=0.9,de;q=0.8')).toBe('en')
  })

  it('liefert undefined für unbekannte/fehlende Sprachen', () => {
    expect(parseAcceptLanguage('fr-FR,es;q=0.9')).toBeUndefined()
    expect(parseAcceptLanguage(null)).toBeUndefined()
    expect(parseAcceptLanguage('')).toBeUndefined()
  })
})
