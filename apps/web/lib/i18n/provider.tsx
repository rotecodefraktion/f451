'use client'

/**
 * Client-Gegenstück zu `server.ts#getT` für Client-Inseln (z. B.
 * `app/lang-switcher.tsx`). Der Client LEITET die Sprache NIE selbst ab
 * (kein eigenes `Accept-Language`-Parsing, kein Cookie-Read im Client) —
 * `<LocaleProvider>` wird von einer Server Component (`app/layout.tsx`) mit
 * dem bereits per `getLocale()` ermittelten `locale` + passendem Wörterbuch
 * geseedet. Das hält Server- und Client-Render für denselben Request
 * garantiert konsistent (kein Hydration-Mismatch durch abweichende
 * Sprachwahl).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { t as translate, type DotPaths, type Params } from './format.js'
import type { Locale, Messages } from './types.js'

interface LocaleContextValue {
  locale: Locale
  messages: Messages
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined)

export interface LocaleProviderProps {
  locale: Locale
  messages: Messages
  children: ReactNode
}

/** Stellt `locale`/`messages` für `useT()` bereit. Ein einziger Provider
 *  in `app/layout.tsx`, um den gesamten Body herum. */
export function LocaleProvider({ locale, messages, children }: LocaleProviderProps) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export interface UseTResult {
  locale: Locale
  /** Volles aktives Wörterbuch — für den seltenen Fall, dass ein Aufrufer
   *  einen Key dynamisch (Laufzeit-Variable statt Literal) auflösen muss,
   *  s. `app/lang-switcher.tsx` (`messages.shell.langSwitcher.locales[option]`
   *  bleibt dabei voll typsicher, `t()`s Key-Typ ist absichtlich nur für
   *  Literal-Keys ausgelegt). */
  messages: Messages
  t: (key: DotPaths<Messages>, params?: Params) => string
}

/** Hook für Client-Komponenten: `t` + aktive `locale`/`messages`. Wirft
 *  außerhalb eines `<LocaleProvider>` (Fail-Fast statt stiller
 *  Default-Sprache — ein fehlender Provider ist ein Verdrahtungsfehler,
 *  kein Laufzeitfall). */
export function useT(): UseTResult {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useT() benötigt einen umgebenden <LocaleProvider> (siehe app/layout.tsx)')
  const { locale, messages } = ctx
  return useMemo(
    () => ({
      locale,
      messages,
      t: (key: DotPaths<Messages>, params?: Params) => translate(messages, key, params),
    }),
    [locale, messages],
  )
}
