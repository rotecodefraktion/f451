'use client'

import { usePathname } from 'next/navigation'
import type { AnchorHTMLAttributes, ReactNode } from 'react'

export interface ActiveLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'aria-current' | 'onClick'> {
  href: string
  /** Zusätzliche Klasse, wenn `href` der aktuellen Route entspricht (Default: `active`). */
  activeClassName?: string
  /**
   * Stoppt die Event-Propagation eines Klicks (z. B. damit ein Link in einem
   * umgebenden `<summary>` dessen Auf-/Zuklapp-Toggle nicht mit auslöst). Ein
   * `boolean`-Prop statt einer `onClick`-Funktion, weil `<ActiveLink>` von
   * einer Server Component (`components/tree.tsx`) aus verwendet wird —
   * Funktionen lassen sich nicht über die Server/Client-Grenze reichen.
   */
  stopClickPropagation?: boolean
  children: ReactNode
}

/**
 * Winzige Client-Insel nur für die Aktiv-Markierung eines Links: vergleicht
 * `href` mit `usePathname()` und hängt bei Übereinstimmung `activeClassName`
 * (+ `aria-current="page"`) an. `href` ist bereits über `wikiPageHref`
 * URL-kodiert (siehe `lib/urls.ts`) — `usePathname()` liefert denselben
 * kodierten Pfad zurück (Next dekodiert dabei nicht), der Vergleich ist also
 * konsistent.
 *
 * Der restliche Seitenbaum (`components/tree.tsx`) bleibt dadurch eine
 * Server Component; nur dieser Wrapper braucht Client-JS — analog zu den
 * bestehenden Client-Inseln `app/theme-toggle.tsx` und
 * `components/account-menu.tsx` (Finding 2, Task 3 Review).
 */
export function ActiveLink({
  href,
  activeClassName = 'active',
  className,
  stopClickPropagation,
  children,
  ...rest
}: ActiveLinkProps) {
  const pathname = usePathname()
  const active = pathname === href
  const classes = [className, active ? activeClassName : ''].filter(Boolean).join(' ')

  return (
    <a
      href={href}
      className={classes || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={stopClickPropagation ? (event) => event.stopPropagation() : undefined}
      {...rest}
    >
      {children}
    </a>
  )
}
