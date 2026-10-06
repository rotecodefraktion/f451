import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { apiFetch } from './api.js'
import { frameShape, type FrameShape } from './frame-shape.js'
import type { ThemeCssDeclarations } from './theme-style.js'

/** The brand of the resolved chain (addendum §5); URLs go through the web proxy. */
export interface ResolvedBrand {
  name: string | null
  logoUrl: string | null
  faviconUrl: string | null
}

/** Answer of `GET /api/theme/resolved`. */
export interface ResolvedThemeResponse {
  css: ThemeCssDeclarations
  brand?: ResolvedBrand | null
  attributes?: Record<string, string>
  /** Every switch with its resolved value, defaults included (structure spec 2). */
  switches?: Record<string, string>
  /** URLs of the theme stylesheets that apply, instance then space (f451#61). */
  stylesheets?: string[]
}

/**
 * The resolved theme of the current request (instance, space and user layer).
 * The space comes from the middleware (`x-f451-space`, already URI-encoded —
 * the root layout has no route params); the pattern check keeps a
 * client-supplied value on an unmatched request (prefetch) from adding query
 * parameters. The session cookie is passed through like in the page
 * components. Any failure — API down, unexpected status — gives `null`: a
 * theme must never break rendering.
 *
 * Wrapped in React's `cache`, so the root layout (style, favicon),
 * `generateMetadata` (title) and the `<Shell>` (top bar brand) share ONE call
 * per request — the Shell is rendered by the pages, not by the layout, so the
 * brand cannot be handed down as a prop.
 */
export const getResolvedTheme = cache(async (): Promise<ResolvedThemeResponse | null> => {
  const requestHeaders = await headers()
  const spaceParam = requestHeaders.get('x-f451-space')
  const resolvedPath =
    spaceParam && /^[A-Za-z0-9\-_.!~*'()%]+$/.test(spaceParam)
      ? `/api/theme/resolved?space=${spaceParam}`
      : '/api/theme/resolved'
  const cookieHeader = (await cookies()).toString() || undefined
  return apiFetch<ResolvedThemeResponse>(resolvedPath, { cookie: cookieHeader }).catch(() => null)
})

/** The brand of the current request; `null` without one or when the theme could not be loaded. */
export async function getBrand(): Promise<ResolvedBrand | null> {
  return (await getResolvedTheme())?.brand ?? null
}

/** The resolved switches of the current request; empty when the theme could not be loaded. */
export async function getSwitches(): Promise<Record<string, string>> {
  return (await getResolvedTheme())?.switches ?? {}
}

/** The frame of the current request; Editorial defaults when the theme could not be loaded. */
export async function getFrame(opts: { hasTree: boolean }): Promise<FrameShape> {
  return frameShape((await getResolvedTheme())?.switches, opts)
}
