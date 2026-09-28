import { describe, expect, it } from 'vitest'
import { buildResolveImage, buildResolveLink, LinkResolver } from '../src/indexer/resolve-links.js'

describe('LinkResolver: Titel-Kollisionen (F3)', () => {
  it('gewinnt bei mehreren Titel-Treffern über den kürzesten Pfad, unabhängig von der Reihenfolge', () => {
    const withOrderA = new LinkResolver([
      { id: 'long', path: 'ops/legacy/deployment-details/index.md', title: 'Deployment' },
      { id: 'short', path: 'dep/index.md', title: 'Deployment' },
    ])
    const withOrderB = new LinkResolver([
      { id: 'short', path: 'dep/index.md', title: 'Deployment' },
      { id: 'long', path: 'ops/legacy/deployment-details/index.md', title: 'Deployment' },
    ])

    // Kürzester Pfad gewinnt, gleiches Ergebnis unabhängig von der Eingabereihenfolge.
    expect(withOrderA.resolve('Deployment', 'wikilink', 'irrelevant/index.md')).toBe('short')
    expect(withOrderB.resolve('Deployment', 'wikilink', 'irrelevant/index.md')).toBe('short')
  })

  it('entscheidet bei gleicher Pfadlänge alphabetisch, unabhängig von der Reihenfolge', () => {
    const withOrderA = new LinkResolver([
      { id: 'zzz', path: 'zzz/index.md', title: 'Monitoring' },
      { id: 'aaa', path: 'aaa/index.md', title: 'Monitoring' },
    ])
    const withOrderB = new LinkResolver([
      { id: 'aaa', path: 'aaa/index.md', title: 'Monitoring' },
      { id: 'zzz', path: 'zzz/index.md', title: 'Monitoring' },
    ])

    // Gleiche Pfadlänge ('aaa/index.md' vs. 'zzz/index.md') → alphabetisch kleinster Pfad gewinnt.
    expect(withOrderA.resolve('Monitoring', 'wikilink', 'irrelevant/index.md')).toBe('aaa')
    expect(withOrderB.resolve('Monitoring', 'wikilink', 'irrelevant/index.md')).toBe('aaa')
  })
})

describe('buildResolveImage', () => {
  // Bug (Live-Betrieb): Seiten ohne explizite Frontmatter-`id` bekommen die
  // Fallback-Id `path:<space>/<datei>` (siehe `index-space.ts`, Formel
  // `path:${spaceId}/${filePath}`) — mit Slashes. Unkodiert in die Media-URL
  // eingesetzt, bindet die Route `/media/:pageId/*` nur den Teil vor dem
  // ersten weiteren `/` als `pageId`, der Rest landet im Wildcard → falsches
  // Ziel, Bild/Diagramm kaputt. Das Frontend-Pendant (`apps/web/lib/urls.ts`,
  // `mediaHref`) kodiert die pageId deshalb bereits über
  // `encodeURIComponent` — `buildResolveImage` muss dasselbe tun, sonst
  // driften Server- und Client-Erzeugung der Media-URL auseinander.
  it('kodiert eine pageId mit Slashes (Fallback-Id `path:<space>/<datei>`)', () => {
    const resolveImage = buildResolveImage('path:betrieb/index.md')
    expect(resolveImage('_media/x.svg')).toBe('/media/path%3Abetrieb%2Findex.md/x.svg')
  })

  it('lässt eine einfache pageId ohne Sonderzeichen unverändert', () => {
    const resolveImage = buildResolveImage('page-1')
    expect(resolveImage('_media/x.svg')).toBe('/media/page-1/x.svg')
  })

  it('lässt absolute URLs und `/`-Pfade unangetastet (Bestandsverhalten)', () => {
    const resolveImage = buildResolveImage('path:betrieb/index.md')
    expect(resolveImage('https://example.org/bild.png')).toBe('https://example.org/bild.png')
    expect(resolveImage('/schon/absolut.png')).toBe('/schon/absolut.png')
  })

  // Bugfix Review-Diff: die Diff (`GET /review`, workflow.ts) MUSS die
  // vorgeschlagene Diagramm-/Bild-Version aus dem Draft-Branch laden, sonst
  // rendert sie die alte `main`-Fassung (die Media-Route defaultet ohne `ref`
  // auf `main`). `ref='draft'` hängt daher `?ref=draft` an die Media-URL.
  it("hängt bei ref='draft' `?ref=draft` an die Media-URL (Review-Diff-Frische)", () => {
    const resolveImage = buildResolveImage('home', 'draft')
    expect(resolveImage('_media/arch.drawio.svg')).toBe('/media/home/arch.drawio.svg?ref=draft')
  })

  it("hängt bei ref='draft' den Query auch bei kodierter Fallback-Id korrekt an", () => {
    const resolveImage = buildResolveImage('path:betrieb/index.md', 'draft')
    expect(resolveImage('_media/x.svg')).toBe('/media/path%3Abetrieb%2Findex.md/x.svg?ref=draft')
  })

  // Regression Leseansicht: der Default (main) bleibt query-frei — sonst würde
  // die indexierte, in `htmlRendered` gespeicherte URL einen `?ref`-Query
  // tragen und die Media-Route auf den Draft-Branch schicken.
  it("bleibt bei ref='main' (Default) query-frei", () => {
    expect(buildResolveImage('home')('_media/arch.drawio.svg')).toBe('/media/home/arch.drawio.svg')
    expect(buildResolveImage('home', 'main')('_media/arch.drawio.svg')).toBe('/media/home/arch.drawio.svg')
  })

  it("lässt absolute URLs auch bei ref='draft' unangetastet (kein `?ref` an Fremd-URLs)", () => {
    const resolveImage = buildResolveImage('home', 'draft')
    expect(resolveImage('https://example.org/bild.png')).toBe('https://example.org/bild.png')
    expect(resolveImage('/schon/absolut.png')).toBe('/schon/absolut.png')
  })
})

describe('buildResolveLink', () => {
  // Bug #27 (Live-Betrieb): buildResolveLink baute `{ href: '/pages/<tid>' }` —
  // `/pages/*` ist keine App-Route (die App nutzt `/wiki/<space>/<pageId>`,
  // `apps/web/lib/urls.ts#wikiPageHref` bzw. Route
  // `apps/web/app/wiki/[space]/(shell)/[pageId]/page.tsx`), UND `tid` wurde nicht
  // URL-kodiert — Fallback-Ids ohne Frontmatter-`id` haben die Form
  // `path:<space>/<datei>` (Doppelpunkt + Slashes), unkodiert im href ergäbe das
  // mehr als zwei Pfadsegmente und die dynamische Route würde nicht treffen
  // (404). Jeder Wikilink führte deshalb im Browser zu 404. Fix orientiert sich
  // an `buildResolveImage` (kodiert die pageId bereits korrekt) und an
  // `wikiPageHref`, deren Kodierung/Format hier exakt gespiegelt werden muss,
  // sonst driften Server- und Client-Erzeugung wieder auseinander.
  it('erzeugt eine /wiki/<space>/<pageId>-Route mit korrekt kodierter Fallback-Id (nicht /pages/…)', () => {
    const resolver = new LinkResolver([
      { id: 'path:demo/runbooks/deployment.md', path: 'runbooks/deployment/index.md', title: 'Deployment' },
    ])
    const resolveLink = buildResolveLink(resolver, 'irrelevant/index.md', 'demo', 'irrelevant-page-id')

    const resolved = resolveLink!('Deployment', 'wikilink')

    expect(resolved).toEqual({ href: '/wiki/demo/path%3Ademo%2Frunbooks%2Fdeployment.md' })
  })

  it('kodiert auch den space-Teil des hrefs (Konsistenz zu wikiSpaceHref)', () => {
    const resolver = new LinkResolver([{ id: 'p1', path: 'index.md', title: 'Ziel' }])
    const resolveLink = buildResolveLink(resolver, 'irrelevant/index.md', 'mein space', 'irrelevant-page-id')

    expect(resolveLink!('Ziel', 'wikilink')).toEqual({ href: '/wiki/mein%20space/p1' })
  })

  it('liefert null für nicht auflösbare Wikilinks (Bestandsverhalten, Broken Link)', () => {
    const resolver = new LinkResolver([])
    const resolveLink = buildResolveLink(resolver, 'irrelevant/index.md', 'demo', 'irrelevant-page-id')

    expect(resolveLink!('Unbekannt', 'wikilink')).toBeNull()
  })

  // Bug (Live-Betrieb, Editor-Erweiterung „Datei-Anhänge"): ein Dokument-
  // Anhang-Link `[test-doc.pdf](_media/test-doc.pdf)` wurde in der Leseansicht
  // als broken-link gerendert, weil `LinkResolver#resolveRelative` `_media/…`
  // nur gegen Seitenpfade auflöst (nie Treffer) — anders als Bilder, die über
  // `buildResolveImage` bereits korrekt auf die Media-URL umgeschrieben
  // werden. Fix: `buildResolveLink` erkennt `_media/…`-Ziele vor dem
  // Seiten-Resolver und liefert dieselbe Media-URL wie `buildResolveImage`.
  it('löst einen relativen `_media/…`-Anhang-Link auf die Media-URL auf (nicht broken)', () => {
    const resolver = new LinkResolver([])
    const resolveLink = buildResolveLink(resolver, 'onboarding/index.md', 'demo', 'page-1')

    expect(resolveLink!('_media/test-doc.pdf', 'relative')).toEqual({
      href: '/media/page-1/test-doc.pdf',
    })
  })

  it('kodiert Anhang-Dateiname und Fallback-pageId in der Media-URL wie buildResolveImage', () => {
    const resolver = new LinkResolver([])
    const resolveLink = buildResolveLink(resolver, 'onboarding/index.md', 'demo', 'path:demo/onboarding.md')

    expect(resolveLink!('_media/mein dokument.pdf', 'relative')).toEqual({
      href: '/media/path%3Ademo%2Fonboarding.md/mein%20dokument.pdf',
    })
  })

  it("hängt bei ref='draft' `?ref=draft` an die Anhang-Media-URL an (Review-Diff-Frische)", () => {
    const resolver = new LinkResolver([])
    const resolveLink = buildResolveLink(resolver, 'onboarding/index.md', 'demo', 'page-1', 'draft')

    expect(resolveLink!('_media/test-doc.pdf', 'relative')).toEqual({
      href: '/media/page-1/test-doc.pdf?ref=draft',
    })
  })

  it('löst relative Seiten-Links weiterhin über den Seiten-Resolver auf (kein Regress durch den `_media/`-Sonderfall)', () => {
    const resolver = new LinkResolver([
      { id: 'onboarding', path: 'onboarding/index.md', title: 'Onboarding' },
      { id: 'setup', path: 'onboarding/setup/index.md', title: 'Setup' },
    ])
    const resolveLink = buildResolveLink(resolver, 'onboarding/index.md', 'demo', 'onboarding')

    expect(resolveLink!('setup/index.md', 'relative')).toEqual({ href: '/wiki/demo/setup' })
  })
})
