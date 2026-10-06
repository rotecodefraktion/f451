import path from 'node:path'
import type { RenderOptions } from '@f451/markdown'

/**
 * Minimal-Sicht auf eine indexierte Seite, die für die Link-Auflösung nötig ist.
 * `path` ist der `index.md`-Dateipfad (z. B. `betrieb/deployment/index.md`).
 */
export interface ResolvablePage {
  id: string
  path: string
  title: string
}

/** Entfernt einen `#anchor`-Suffix von einem Linkziel. */
function stripAnchor(target: string): string {
  const hash = target.indexOf('#')
  return hash === -1 ? target : target.slice(0, hash)
}

/** Tie-Break bei mehreren Seiten mit demselben Titel (F3): kürzester Pfad
 *  gewinnt, bei gleicher Länge alphabetisch. Deterministisch unabhängig von
 *  der Reihenfolge, in der Seiten eingesammelt wurden. */
function isBetterTitleMatch(candidate: ResolvablePage, current: ResolvablePage): boolean {
  if (candidate.path.length !== current.path.length) {
    return candidate.path.length < current.path.length
  }
  return candidate.path < current.path
}

/**
 * Link-Auflöser über die Menge aller Seiten eines Space (Zwei-Pass-Indexierung:
 * erst alle Seiten sammeln, dann hiermit Kanten auflösen).
 *
 * Auflösungsregeln (Plan Task 3):
 * - Wikilink: Pfad-Match auf `<ziel>/index.md` ODER Titel-Match (case-insensitive).
 * - Relativer Link: Normalisierung relativ zum Verzeichnis der Quellseite.
 * - Relation (Frontmatter): Match auf Seiten-Id, sonst Pfad, sonst Titel.
 * - Nicht auflösbar → null (Broken Link).
 */
export class LinkResolver {
  readonly #byPath = new Map<string, string>()
  readonly #byTitle = new Map<string, string>()
  readonly #ids = new Set<string>()

  constructor(pages: readonly ResolvablePage[]) {
    // Titel-Kollisionen deterministisch auflösen (F3): der kürzeste Pfad gewinnt,
    // bei Gleichstand alphabetisch — unabhängig von der Eingabereihenfolge (im
    // Gegensatz zu "erster Treffer gewinnt", das von der Baum-/Provider-Reihenfolge
    // abhängt und damit nicht zwingend stabil ist).
    const titleWinner = new Map<string, ResolvablePage>()
    for (const page of pages) {
      this.#byPath.set(page.path, page.id)
      this.#ids.add(page.id)
      const key = page.title.trim().toLowerCase()
      if (key.length === 0) continue
      const current = titleWinner.get(key)
      if (!current || isBetterTitleMatch(page, current)) titleWinner.set(key, page)
    }
    for (const [key, page] of titleWinner) this.#byTitle.set(key, page.id)
  }

  /**
   * Löst ein Linkziel aus dem Seitentext zu einer Seiten-Id auf.
   * `sourcePath` ist der `index.md`-Pfad der Quellseite (für relative Links).
   */
  resolve(rawTarget: string, kind: 'wikilink' | 'relative', sourcePath: string): string | null {
    return kind === 'wikilink'
      ? this.#resolveWikilink(rawTarget)
      : this.#resolveRelative(rawTarget, sourcePath)
  }

  #resolveWikilink(rawTarget: string): string | null {
    const target = stripAnchor(rawTarget).trim()
    if (target.length === 0) return null
    // The page id first: the editor stores ids in wikilinks (user guide, "Wikilinks"),
    // and only root-level pages have a path equal to their id. Then path, then title.
    if (this.#ids.has(target)) return target
    const cleaned = target.replace(/^\.?\//, '').replace(/\/+$/, '')
    const pathKey = cleaned.endsWith('/index.md') || cleaned === 'index.md'
      ? cleaned
      : `${cleaned}/index.md`
    const byPath = this.#byPath.get(pathKey)
    if (byPath) return byPath
    const byTitle = this.#byTitle.get(target.toLowerCase())
    return byTitle ?? null
  }

  #resolveRelative(rawTarget: string, sourcePath: string): string | null {
    const target = stripAnchor(rawTarget).trim()
    if (target.length === 0) return null
    const sourceDir = path.posix.dirname(sourcePath)
    const joined = path.posix.normalize(path.posix.join(sourceDir, target))
    // Verlässt der Pfad die Repo-Wurzel, ist er nicht auflösbar.
    if (joined.startsWith('..')) return null
    const normalized = joined.replace(/^\.?\//, '').replace(/^\.$/, '')
    const direct = this.#byPath.get(normalized)
    if (direct) return direct
    const asDir = `${normalized.replace(/\/+$/, '')}/index.md`
    return this.#byPath.get(asDir) ?? null
  }

  /**
   * Löst eine Relation aus dem Frontmatter zu einer Seiten-Id auf. Relations
   * verweisen typischerweise auf Seiten-Ids, fallweise auf Pfade oder Titel.
   */
  resolveRelation(rawTarget: string): string | null {
    const target = rawTarget.trim()
    if (target.length === 0) return null
    if (this.#ids.has(target)) return target
    const asPath = this.#byPath.get(`${target.replace(/\/+$/, '')}/index.md`)
    if (asPath) return asPath
    return this.#byTitle.get(target.toLowerCase()) ?? null
  }

  /**
   * Versucht, eine gebrochene Kante (toPageId = null) mit dem aktuellen
   * Seitenbestand erneut aufzulösen (Webhook-Heilung, Plan Task 4). Kanten
   * persistieren keine Wikilink/relativ-Unterscheidung, daher werden für
   * `link`-Kanten beide Interpretationen versucht. Hierarchie-Kanten
   * speichern als `rawTarget` bereits den exakten Eltern-Pfad.
   */
  healBroken(rawTarget: string, type: 'link' | 'relation' | 'hierarchy', sourcePath: string): string | null {
    if (type === 'relation') return this.resolveRelation(rawTarget)
    if (type === 'hierarchy') return this.#byPath.get(rawTarget) ?? null
    return this.#resolveWikilink(rawTarget) ?? this.#resolveRelative(rawTarget, sourcePath)
  }

  /**
   * Ermittelt die Hierarchie-Elternseite: die Seite im nächstgelegenen
   * Vorfahren-Verzeichnis, das ein `index.md` enthält. Die Wurzelseite
   * (`index.md`) hat keine Elternseite.
   */
  parentOf(sourcePath: string): { id: string; path: string } | null {
    const ownDir = path.posix.dirname(sourcePath)
    if (ownDir === '.' || ownDir === '/' || ownDir === '') return null
    let cur = path.posix.dirname(ownDir)
    for (;;) {
      const candidate = cur === '.' || cur === '' ? 'index.md' : `${cur}/index.md`
      const id = this.#byPath.get(candidate)
      if (id) return { id, path: candidate }
      if (cur === '.' || cur === '') return null
      cur = path.posix.dirname(cur)
    }
  }
}

/**
 * Erkennt, ob ein relatives Linkziel auf einen Anhang im `_media/`-Ordner zeigt
 * (Datei-Verweis, KEIN Seiten-/Wikiziel). Geteilte Definition für Render- UND
 * Index-Pfad (Bugfix Live-Betrieb: die rote „N Verweise … nicht auflösbar"-
 * Notice erschien weiterhin für `_media/`-Anhänge, obwohl `buildResolveLink`
 * sie längst korrekt als `<a>`-Link rendert — Ursache war, dass
 * `replaceEdgesForPage` (`index-space.ts`) beim Kanten-Aufbau den rohen
 * `LinkResolver` OHNE diese `_media/`-Sonderbehandlung nutzte und den Anhang
 * dadurch als Broken-Link-Kante zählte. Beide Stellen nutzen jetzt denselben
 * Helper statt zweier Kopien der Bedingung, die sonst wieder auseinanderlaufen
 * könnten).
 */
export function isMediaLink(target: string): boolean {
  return target.replace(/^\.?\//, '').startsWith('_media/')
}

/**
 * Baut die Media-URL für einen `_media/…`-Pfad (Bild ODER Dokument-Anhang) —
 * absolute URLs/Pfade unverändert, führendes `_media/`-Segment gestrippt,
 * jedes Pfadsegment einzeln URL-encodiert. Geteilte Grundlage für
 * `buildResolveImage` (Bild-`src`) UND den `_media/`-Sonderfall in
 * `buildResolveLink` (Dokument-Anhang-`href`) — beide brauchen exakt dieselbe
 * Pfadregel/Kodierung, sonst driften Bild- und Anhang-URLs auseinander.
 *
 * `ref` (Default `'main'`) steuert, aus welchem Branch die Datei kommt: die
 * Leseansicht-Indexierung (`upsertPage`) rendert gegen `main` und lässt die
 * URL deshalb query-frei; die Review-Diff (`GET /review`) MUSS dagegen die
 * VORGESCHLAGENE Diagramm-/Bild-/Anhang-Version zeigen und rendert daher mit
 * `ref='draft'` → `?ref=draft` an die Media-URL angehängt (Bugfix: sonst lädt
 * die Diff die alte `main`-Fassung einer im Draft geänderten Datei, weil
 * `GET /media/:pageId/*` ohne `ref` auf `main` defaultet, media.ts). Das
 * `?ref=draft`-Gate der Media-Route ist Schreibrecht — der Reviewer hat es.
 */
function buildMediaUrl(pageId: string, src: string, ref: 'main' | 'draft', release?: string): string {
  const clean = src.replace(/^\.?\//, '')
  const withoutMediaPrefix = clean.startsWith('_media/') ? clean.slice('_media/'.length) : clean
  const encoded = withoutMediaPrefix
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  // pageId kodieren (Bug-Fix, Live-Betrieb): Fallback-Ids ohne Frontmatter-
  // `id` haben die Form `path:<space>/<datei>` (Slashes) — unkodiert bindet
  // die Route `/media/:pageId/*` nur den Teil vor dem nächsten `/` als
  // `pageId`. Gleiche Kodierung wie `mediaHref` im Frontend (`apps/web/lib/
  // urls.ts`), sonst driften Server- und Client-Erzeugung auseinander.
  const base = `/media/${encodeURIComponent(pageId)}/${encoded}`
  if (release) return `${base}?release=${encodeURIComponent(release)}`
  return ref === 'draft' ? `${base}?ref=draft` : base
}

/** Images of a frozen release copy (#40) come from its own `_media/` folder. */
export function buildResolveReleaseImage(pageId: string, version: string): NonNullable<RenderOptions['resolveImage']> {
  return (src: string): string => {
    if (src.includes('://') || src.startsWith('/')) return src
    return buildMediaUrl(pageId, src, 'main', version)
  }
}

/**
 * Baut den `resolveLink`-Callback für `renderHtml`/`diffMarkdown`
 * (`RenderOptions['resolveLink']`) aus einem gefüllten `LinkResolver`, dem
 * `index.md`-Pfad der Quellseite, der Space-Id und der Seiten-Id — dieselbe
 * Konstruktion, die `upsertPage` (`index-space.ts`) für die normale
 * Seiten-Renderung nutzt. Geteilt statt dupliziert (Finding 2, Fix-Runde 1:
 * `GET /review` braucht exakt dieselbe Auflösung wie der Indexer, sonst
 * driften beide Pfade auseinander), Reviewer-Auflage aus derselben Runde
 * ("resolveDiffImage-Duplikation" bereits moniert — hier von vornherein
 * geteilt statt kopiert).
 *
 * Bugfix #27 (Live-Betrieb, jeder Wikilink führte im Browser zu 404): der
 * frühere Href `/pages/<tid>` ist keine App-Route — die App liest Seiten unter
 * `/wiki/<space>/<pageId>` (`apps/web/lib/urls.ts#wikiPageHref`, Route
 * `apps/web/app/wiki/[space]/(shell)/[pageId]/page.tsx`). Zusätzlich fehlte die
 * Kodierung: Fallback-Ids ohne Frontmatter-`id` haben die Form
 * `path:<space>/<datei>` (Doppelpunkt + Slashes) — unkodiert im href hätte das
 * mehr als zwei Pfadsegmente ergeben und die dynamische Route nicht getroffen.
 * Format/Kodierung hier bewusst identisch zu `wikiPageHref` (Space UND
 * pageId je einzeln `encodeURIComponent`-kodiert) und zur Segment-Kodierung
 * in `buildResolveImage` — sonst driften Server- und Client-Erzeugung wieder
 * auseinander.
 *
 * Bugfix (Live-Betrieb, Editor-Erweiterung „Datei-Anhänge"): relative Links auf
 * eine Anhang-Datei im `_media/`-Ordner (z. B. `[test-doc.pdf](_media/test-
 * doc.pdf)`) sind KEIN Seiten-Ziel — der Seiten-Resolver (`LinkResolver
 * #resolveRelative`, sucht ausschließlich in `#byPath`) kannte diesen Fall
 * nicht und lieferte immer `null`, wodurch die Leseansicht jeden Dokument-
 * Anhang-Link als `broken-link`-Span rendert, obwohl Upload/Auslieferung
 * (`GET /media/:pageId/*`) korrekt funktionieren. Fix: `_media/`-Ziele werden
 * VOR dem Seiten-Resolver erkannt und wie `buildResolveImage` auf die
 * Media-URL umgeschrieben (exakt dieselbe Pfadregel/Kodierung/`ref`-
 * Behandlung, `buildMediaUrl`) — echte Seiten-Wikilinks/relative Links bleiben
 * unverändert über `LinkResolver` aufgelöst.
 */
export function buildResolveLink(
  resolver: LinkResolver,
  sourcePath: string,
  space: string,
  pageId: string,
  ref: 'main' | 'draft' = 'main',
): RenderOptions['resolveLink'] {
  return (rawTarget, kind) => {
    if (kind === 'relative' && isMediaLink(rawTarget)) {
      const target = rawTarget.replace(/^\.?\//, '')
      return { href: buildMediaUrl(pageId, target, ref) }
    }
    const tid = resolver.resolve(rawTarget, kind, sourcePath)
    return tid ? { href: `/wiki/${encodeURIComponent(space)}/${encodeURIComponent(tid)}` } : null
  }
}

/**
 * Baut den `resolveImage`-Callback (`RenderOptions['resolveImage']`) für eine
 * Seiten-Id — dieselbe Pfadregel wie `upsertPage`s Bild-Resolver (absolute
 * URLs/Pfade unverändert, führendes `_media/`-Segment gestrippt, jedes
 * Pfadsegment einzeln URL-encodiert), hier geteilt zwischen Indexer und
 * Workflow-Routen (`GET /review`) statt als zweite Kopie gepflegt.
 *
 * `ref` (Default `'main'`) siehe `buildMediaUrl`.
 */
export function buildResolveImage(
  pageId: string,
  ref: 'main' | 'draft' = 'main',
): NonNullable<RenderOptions['resolveImage']> {
  return (src: string): string => {
    if (src.includes('://') || src.startsWith('/')) return src
    return buildMediaUrl(pageId, src, ref)
  }
}
