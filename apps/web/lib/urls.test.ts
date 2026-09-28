import { describe, expect, it } from 'vitest'
import {
  apiPageRawPath,
  apiSpaceGraphPath,
  apiSpaceMetadataSchemaPath,
  apiSpaceTreePath,
  decodeRouteParam,
  mediaHref,
  wikiGraphHref,
  wikiMetadataSchemaHref,
  wikiPageEditHref,
  wikiPageHref,
  wikiPageReviewHref,
  wikiPageVersionsHref,
  wikiSpaceHref,
} from './urls.js'

// Regelfall beim Einbinden eines Bestands-Repos: Seiten ohne Frontmatter-`id`
// fallen auf `path:<repo-relativer-pfad>` zurück — mit Slashes und einem
// Doppelpunkt. Genau diese Id war der Auslöser für Finding 1 (Task 3 Review).
const NASTY_ID = 'path:demo/a/b.md'

describe('wikiSpaceHref', () => {
  it('baut eine einfache Space-URL', () => {
    expect(wikiSpaceHref('demo')).toBe('/wiki/demo')
  })

  it('kodiert Slashes in der Space-Id', () => {
    expect(wikiSpaceHref('demo/sub')).toBe('/wiki/demo%2Fsub')
  })
})

describe('wikiPageHref', () => {
  it('baut eine einfache Seiten-URL', () => {
    expect(wikiPageHref('demo', 'p-overview')).toBe('/wiki/demo/p-overview')
  })

  it('kodiert Slashes und Doppelpunkt der Fallback-Id (path:demo/a/b.md)', () => {
    const href = wikiPageHref('demo', NASTY_ID)
    expect(href).toContain('%2F')
    expect(href).toContain('%3A')
    expect(href).not.toMatch(/path:demo\/a\/b\.md/)
    expect(href).toBe('/wiki/demo/path%3Ademo%2Fa%2Fb.md')
  })

  it('erzeugt genau zwei Pfadsegmente nach /wiki/<space>/ — auch bei einer Id mit Slashes', () => {
    const href = wikiPageHref('demo', NASTY_ID)
    const segments = href.split('/').filter(Boolean)
    expect(segments).toEqual(['wiki', 'demo', 'path%3Ademo%2Fa%2Fb.md'])
  })

  it('kodiert auch eine Space-Id mit Sonderzeichen', () => {
    expect(wikiPageHref('a b', 'p1')).toBe('/wiki/a%20b/p1')
  })
})

describe('decodeRouteParam', () => {
  it('dekodiert einen rohen, noch kodierten Routen-Param zurück in die Original-Id', () => {
    expect(decodeRouteParam('path%3Ademo%2Fa%2Fb.md')).toBe(NASTY_ID)
  })

  it('ist ein No-Op für Ids ohne Sonderzeichen', () => {
    expect(decodeRouteParam('demo')).toBe('demo')
  })

  it('bildet zusammen mit wikiPageHref eine Round-Trip-Kette (encode → decode → encode)', () => {
    const href = wikiPageHref('demo', NASTY_ID)
    const rawParam = href.split('/').pop()!
    expect(decodeRouteParam(rawParam)).toBe(NASTY_ID)
  })
})

describe('apiSpaceTreePath', () => {
  it('baut den Tree-Endpunkt für einen einfachen Space', () => {
    expect(apiSpaceTreePath('demo')).toBe('/api/spaces/demo/tree')
  })

  it('kodiert Slashes in der Space-Id', () => {
    expect(apiSpaceTreePath('demo/sub')).toBe('/api/spaces/demo%2Fsub/tree')
  })
})

describe('wikiPageEditHref', () => {
  it('baut eine einfache Edit-URL', () => {
    expect(wikiPageEditHref('demo', 'p-overview')).toBe('/wiki/demo/p-overview/edit')
  })

  it('kodiert Slashes und Doppelpunkt der Fallback-Id (path:demo/a/b.md)', () => {
    const href = wikiPageEditHref('demo', NASTY_ID)
    expect(href).toBe('/wiki/demo/path%3Ademo%2Fa%2Fb.md/edit')
  })

  it('erzeugt genau drei Pfadsegmente vor /edit — auch bei einer Id mit Slashes', () => {
    const href = wikiPageEditHref('demo', NASTY_ID)
    const segments = href.split('/').filter(Boolean)
    expect(segments).toEqual(['wiki', 'demo', 'path%3Ademo%2Fa%2Fb.md', 'edit'])
  })

  it('kodiert Sonderzeichen (ü) in Space- und Seiten-Id', () => {
    expect(wikiPageEditHref('büro', 'übersicht')).toBe('/wiki/b%C3%BCro/%C3%BCbersicht/edit')
  })

  it('kodiert das #-Zeichen in der Seiten-Id', () => {
    expect(wikiPageEditHref('demo', 'p#1')).toBe('/wiki/demo/p%231/edit')
  })
})

describe('wikiPageReviewHref', () => {
  it('baut eine einfache Review-URL', () => {
    expect(wikiPageReviewHref('demo', 'p-overview')).toBe('/wiki/demo/p-overview/review')
  })

  it('kodiert Slashes und Doppelpunkt der Fallback-Id (path:demo/a/b.md)', () => {
    const href = wikiPageReviewHref('demo', NASTY_ID)
    expect(href).toBe('/wiki/demo/path%3Ademo%2Fa%2Fb.md/review')
  })

  it('erzeugt genau drei Pfadsegmente vor /review — auch bei einer Id mit Slashes', () => {
    const href = wikiPageReviewHref('demo', NASTY_ID)
    const segments = href.split('/').filter(Boolean)
    expect(segments).toEqual(['wiki', 'demo', 'path%3Ademo%2Fa%2Fb.md', 'review'])
  })

  it('kodiert Sonderzeichen (ü) in Space- und Seiten-Id', () => {
    expect(wikiPageReviewHref('büro', 'übersicht')).toBe('/wiki/b%C3%BCro/%C3%BCbersicht/review')
  })
})

describe('mediaHref', () => {
  it('baut eine einfache Media-URL mit Default-ref (main) — OHNE das `_media/`-Präfix (Server baut es selbst)', () => {
    expect(mediaHref('home', '_media/diagram.png')).toBe('/media/home/diagram.png?ref=main')
  })

  it('hängt ref=draft an, wenn explizit angefordert', () => {
    expect(mediaHref('home', '_media/diagram.png', 'draft')).toBe('/media/home/diagram.png?ref=draft')
  })

  it('kodiert die pageId (Fallback-Id mit Slash/Doppelpunkt), belässt relPath-Segmente aber als eigene Pfadsegmente', () => {
    const href = mediaHref(NASTY_ID, '_media/diagram.png')
    expect(href).toBe('/media/path%3Ademo%2Fa%2Fb.md/diagram.png?ref=main')
  })

  it('kodiert jedes relPath-Segment einzeln (Sonderzeichen ü/# im Dateinamen)', () => {
    const href = mediaHref('home', '_media/übersicht #1.png')
    expect(href).toBe('/media/home/%C3%BCbersicht%20%231.png?ref=main')
  })

  it('lässt relPath ohne `_media/`-Präfix unverändert (nur ein führendes Segment wird entfernt)', () => {
    expect(mediaHref('home', 'diagram.png')).toBe('/media/home/diagram.png?ref=main')
  })
})

describe('Graph-URLs (Phase 3b)', () => {
  it('wikiGraphHref kodiert den Space', () => {
    expect(wikiGraphHref('demo/sub')).toBe('/wiki/demo%2Fsub/graph')
  })
  it('apiSpaceGraphPath kodiert den Space', () => {
    expect(apiSpaceGraphPath('demo/sub')).toBe('/api/spaces/demo%2Fsub/graph')
  })
})

describe('Metadaten-Schema-URLs (Metadaten-Feature M4)', () => {
  it('wikiMetadataSchemaHref kodiert den Space', () => {
    expect(wikiMetadataSchemaHref('demo/sub')).toBe('/wiki/demo%2Fsub/schema')
  })
  it('apiSpaceMetadataSchemaPath kodiert den Space', () => {
    expect(apiSpaceMetadataSchemaPath('demo/sub')).toBe('/api/spaces/demo%2Fsub/metadata-schema')
  })
})

describe('apiPageRawPath (Feature „Markdown-Export")', () => {
  it('baut den Raw-Pfad ohne Query-Parameter, wenn download nicht angefordert ist', () => {
    expect(apiPageRawPath('home')).toBe('/api/pages/home/raw')
  })

  it('hängt ?download=1 an, wenn download:true übergeben wird', () => {
    expect(apiPageRawPath('home', { download: true })).toBe('/api/pages/home/raw?download=1')
  })

  it('kodiert die pageId (Fallback-Id mit Slash/Doppelpunkt)', () => {
    expect(apiPageRawPath(NASTY_ID, { download: true })).toBe(
      '/api/pages/path%3Ademo%2Fa%2Fb.md/raw?download=1',
    )
  })
})

describe('wikiPageVersionsHref', () => {
  it('führt ohne Version zur Liste, mit Version zum Vergleich', () => {
    expect(wikiPageVersionsHref('demo', 'p-overview')).toBe('/wiki/demo/p-overview/versions')
    expect(wikiPageVersionsHref('demo', 'p-overview', '1.2.0')).toBe('/wiki/demo/p-overview/versions?from=1.2.0')
  })
})
