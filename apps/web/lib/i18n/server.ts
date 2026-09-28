/**
 * Sprach-Ermittlung + gebundener Übersetzer für Server Components (NUR dort —
 * `cookies()`/`headers()` sind serverseitig; Client-Inseln nutzen stattdessen
 * `useT()` aus `provider.tsx`, geseedet mit dem hier ermittelten `locale`).
 */
import { cookies, headers } from 'next/headers'
import { t as translate, type DotPaths, type Params } from './format.js'
import { de } from './messages/de/index.js'
import { en } from './messages/en/index.js'
import { LANG_COOKIE, type Locale, type Messages } from './types.js'

const DICTIONARIES: Record<Locale, Messages> = { de, en }

/** Erste `de`/`en`-Sprachpräferenz aus einem `Accept-Language`-Header
 *  (`"en-US,en;q=0.9,de;q=0.8"` → `'en'`); ohne Treffer `undefined`. */
export function parseAcceptLanguage(acceptLanguage: string | null | undefined): Locale | undefined {
  if (!acceptLanguage) return undefined
  const tags = acceptLanguage
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase())
    .filter((tag): tag is string => Boolean(tag))
  for (const tag of tags) {
    if (tag.startsWith('de')) return 'de'
    if (tag.startsWith('en')) return 'en'
  }
  return undefined
}

/**
 * Aktive Sprache für den laufenden Request: Cookie `LANG_COOKIE` gewinnt (vom
 * Sprach-Umschalter gesetzt, siehe `app/lang-switcher.tsx`); ohne Cookie
 * entscheidet der `Accept-Language`-Header des Browsers; ohne beides `de`.
 */
export async function getLocale(): Promise<Locale> {
  const cookieValue = (await cookies()).get(LANG_COOKIE)?.value
  if (cookieValue === 'de' || cookieValue === 'en') return cookieValue

  const acceptLanguage = (await headers()).get('accept-language')
  return parseAcceptLanguage(acceptLanguage) ?? 'de'
}

export interface ServerT {
  locale: Locale
  messages: Messages
  /** An `messages` vorgebundenes `t()` — Aufrufer übergeben nur noch Key + Params. */
  t: (key: DotPaths<Messages>, params?: Params) => string
}

/** Wie `getLocale()`, liefert zusätzlich das passende Wörterbuch + ein
 *  vorgebundenes `t()`. Für Server Components im Phase-1-Umfang (Shell,
 *  Space-Layout, …). */
export async function getT(): Promise<ServerT> {
  const locale = await getLocale()
  const messages = DICTIONARIES[locale]
  return {
    locale,
    messages,
    t: (key, params) => translate(messages, key, params),
  }
}
