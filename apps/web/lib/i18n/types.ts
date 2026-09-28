import type { DotPaths, Params } from './format.js'
import type { de } from './messages/de/index.js'

/** Unterstützte UI-Sprachen (Phase 1). Reihenfolge = Anzeigereihenfolge im
 *  Sprach-Umschalter (`app/lang-switcher.tsx`). */
export type Locale = 'de' | 'en'

/** Name des Sprach-Cookies — server- (`server.ts#getLocale`) UND
 *  clientseitig (`app/lang-switcher.tsx`) gelesen/gesetzt. In dieser
 *  `next/headers`-freien Datei, damit auch Client-Komponenten den Namen
 *  importieren können, ohne serverseitige Module ins Client-Bundle zu ziehen.
 *  `f451_`-Namensraum (analog `f451_session`/`f451_oidc_tx` in apps/api) statt
 *  des generischen `lang` — Forgejo/Gitea setzt beim OAuth-Login SELBST ein
 *  `HttpOnly`-Cookie namens `lang` auf demselben Host (Cookies sind
 *  host-, nicht portscoped); ein gleichnamiges App-Cookie würde vom Browser
 *  gegen den httpOnly-Schreibversuch von `document.cookie` stillschweigend
 *  blockiert. */
export const LANG_COOKIE = 'f451_lang'

/**
 * Verbreitert die literalen Stringtypen einer `as const`-Struktur (z. B.
 * `'Zur Startseite'`) zu `string`, OHNE Shape/Verschachtelung zu verändern.
 * Nötig, weil `de` (Referenz-Sprache) `as const` ist — ohne `Widen` wäre
 * `Messages['shell']['topbar']['homeAriaLabel']` der LITERALE deutsche Text
 * selbst, und jeder abweichende EN-Wert ein Typfehler statt nur ein
 * fehlender/falsch geformter Key.
 */
type Widen<T> = T extends string ? string : T extends object ? { [K in keyof T]: Widen<T[K]> } : T

/**
 * Shape des gesamten Wörterbuchs — 1:1 von `de` (der Referenz-Sprache,
 * `messages/de/index.ts`) abgeleitet, NICHT manuell nachgeführt: ein neuer
 * Namespace in einer Folgephase landet automatisch hier, sobald er in
 * `messages/de/index.ts` ergänzt wird (siehe Konvention dort) — dieser Typ
 * selbst muss dafür NIE angefasst werden.
 *
 * Jede `messages/en/*.ts`-Datei wird gegen den passenden Teil dieses Typs
 * annotiert (`Messages['shell']` usw.); fehlt ein Namespace oder ein Key im
 * EN-Wörterbuch, ist das ein Compile-Fehler — nicht erst ein Laufzeit-Bug.
 */
export type Messages = Widen<typeof de>

/**
 * Gebundener Übersetzer-Typ (Rückgabetyp von `getT()#t`/`useT()#t`, s.
 * `server.ts`/`provider.tsx`) — Zusatz für Nicht-Komponenten-Module (`lib/**`),
 * die `t` als PARAMETER von der aufrufenden React-Komponente bzw. dem
 * aufrufenden Server-Code bekommen (keine Hooks außerhalb von Komponenten
 * möglich), z. B. `lib/editor/slash-items.ts`/`upload-queue.ts`/
 * `reset-recovery.ts` (Phase 2) sowie `lib/page-view.ts`/`lib/metadata-view.ts`/
 * `lib/review/diff-view-model.ts` (Phase 3). Identisch zur inline definierten
 * Signatur in `ServerT`/`UseTResult` — beide bleiben unverändert (kein Umbau
 * bestehender Phase-1-Typen), dieser Typ ist nur ein zusätzlicher, benannter
 * Alias für neue Aufrufer. */
export type T = (key: DotPaths<Messages>, params?: Params) => string
