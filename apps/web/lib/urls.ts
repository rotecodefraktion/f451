/**
 * Zentrale Helfer für Wiki-URLs (Server- und Client-Code).
 *
 * Space- und Seiten-Ids kommen aus Frontmatter oder — als Fallback, wenn eine
 * Seite keine `id` im Frontmatter hat — aus dem Repo-Pfad der Quelldatei
 * (`path:<relativer/pfad.md>`, siehe Indexer aus Phase 1c/1d). Genau dieser
 * Fallback ist der Regelfall beim Einbinden eines Bestands-Repos und enthält
 * Slashes (`/`) und einen Doppelpunkt (`:`), z. B. `path:demo/runbooks/deployment.md`.
 *
 * Ohne `encodeURIComponent` würde eine solche Id im `<a href>` oder API-Pfad
 * als mehrere Segmente interpretiert — `/wiki/demo/path:demo/runbooks/deployment.md`
 * hat vier statt zwei Segmente, die dynamische Route `/wiki/[space]/[pageId]`
 * würde also nicht treffen (404) bzw. der API-Aufruf ginge an den falschen
 * Pfad. Jede URL-Konstruktion für den Wiki-Bereich MUSS deshalb über diese
 * Helfer laufen (Finding 1, Task 3 Review).
 *
 * Korrektur ggü. der ursprünglichen Annahme im Task-3-Review: Next.js
 * dekodiert Dynamic-Segment-`params` in diesem Projekt NICHT automatisch —
 * empirisch geprüft per Render-Smoke gegen `next dev` UND den Production-Build
 * (`next build` + `next start`) mit einer Id, die `%3A`/`%2F`/`%20` enthält:
 * `params.pageId` liefert in allen drei Fällen den rohen, noch kodierten
 * Segment-String zurück (z. B. `path%3Ademo%2Fa%2Fb.md` statt
 * `path:demo/a/b.md`). Jede Stelle, die `params.space`/`params.pageId`
 * konsumiert, MUSS sie deshalb zuerst über {@link decodeRouteParam}
 * dekodieren — vor jedem Vergleich mit API-Daten, jeder Anzeige und vor jedem
 * Weiterreichen an `apiFetch` (das dort wieder über `apiSpaceTreePath`
 * kodiert werden muss). Bei Ids ohne Sonderzeichen (z. B. `demo`) bleibt der
 * Unterschied unsichtbar, weil `decodeURIComponent`/`encodeURIComponent` dort
 * No-Ops sind — das hat den Fehler in der ursprünglichen Annahme lange
 * verdeckt.
 */

/**
 * Dekodiert einen rohen Next.js-Routen-Param-Wert (`params.space`,
 * `params.pageId`) zurück in die ursprüngliche, unkodierte Id. Siehe
 * Modul-Kommentar oben für den empirischen Beleg, warum das nötig ist.
 */
export function decodeRouteParam(raw: string): string {
  return decodeURIComponent(raw)
}

/** Href der Space-Startseite, z. B. `wikiSpaceHref('demo')` → `/wiki/demo`. */
export function wikiSpaceHref(space: string): string {
  return `/wiki/${encodeURIComponent(space)}`
}

/**
 * Href einer einzelnen Wiki-Seite, z. B.
 * `wikiPageHref('demo', 'path:demo/runbooks/deployment.md')` →
 * `/wiki/demo/path%3Ademo%2Frunbooks%2Fdeployment.md`.
 */
export function wikiPageHref(space: string, pageId: string): string {
  return `/wiki/${encodeURIComponent(space)}/${encodeURIComponent(pageId)}`
}

/** API-Pfad für den Seitenbaum eines Space, z. B. `/api/spaces/demo/tree`. */
export function apiSpaceTreePath(space: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/tree`
}

/** API-Pfad des Space-weiten Broken-Link-Reports (Phase 3a),
 *  z. B. `/api/spaces/demo/broken-links`. */
export function apiSpaceBrokenLinksPath(space: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/broken-links`
}

/** Href der Verweis-Report-Seite eines Space (Phase 3a),
 *  z. B. `wikiReportHref('demo')` → `/wiki/demo/report`. */
export function wikiReportHref(space: string): string {
  return `${wikiSpaceHref(space)}/report`
}

/** Href der Graph-Ansicht eines Space (Phase 3b),
 *  z. B. `wikiGraphHref('demo')` → `/wiki/demo/graph`. */
export function wikiGraphHref(space: string): string {
  return `${wikiSpaceHref(space)}/graph`
}

/** API-Pfad des Space-Graphen (Phase 3b), z. B. `/api/spaces/demo/graph`. */
export function apiSpaceGraphPath(space: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/graph`
}

/** Href der Metadaten-Schema-Editor-Seite eines Space (Metadaten-Feature M4),
 *  z. B. `wikiMetadataSchemaHref('demo')` → `/wiki/demo/schema`. */
export function wikiMetadataSchemaHref(space: string): string {
  return `${wikiSpaceHref(space)}/schema`
}

/** Href der Vorlagen-Pflege-Seite eines Space (Werkzeuge-Bereich „Vorlagen"),
 *  z. B. `wikiTemplatesHref('demo')` → `/wiki/demo/templates`. */
export function wikiTemplatesHref(space: string): string {
  return `${wikiSpaceHref(space)}/templates`
}

/** API-Pfad der Vorlagen-Liste eines Space (`GET .../templates`), z. B.
 *  `apiSpaceTemplatesPath('demo')` → `/api/spaces/demo/templates`. Die
 *  Vorlagen-Pflege (`PATCH`/`DELETE .../templates/:id`) läuft client-seitig
 *  über `lib/editor/client-api.ts` (Muster {@link apiPageRawPath}: eigene
 *  Pfadkonstruktion dort, kein zusätzlicher Helfer hier nötig). */
export function apiSpaceTemplatesPath(space: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/templates`
}

/** API-Pfad des Metadaten-Schemas eines Space (Metadaten-Feature M1/M4,
 *  `GET`/`PUT`), z. B. `/api/spaces/demo/metadata-schema`. */
export function apiSpaceMetadataSchemaPath(space: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/metadata-schema`
}

/**
 * Href der Bearbeiten-Ansicht einer Wiki-Seite, z. B.
 * `wikiPageEditHref('demo', 'p-overview')` → `/wiki/demo/p-overview/edit`.
 * Kodierung wie {@link wikiPageHref} — dasselbe `pageId`-Encoding-Problem
 * gilt hier unverändert (Modul-Kommentar oben).
 */
export function wikiPageEditHref(space: string, pageId: string): string {
  return `${wikiPageHref(space, pageId)}/edit`
}

/**
 * Href der Review-Ansicht einer Wiki-Seite (Phase 2d Task 6), z. B.
 * `wikiPageReviewHref('demo', 'p-overview')` → `/wiki/demo/p-overview/review`.
 * Kodierung wie {@link wikiPageHref}/{@link wikiPageEditHref} — dasselbe
 * `pageId`-Encoding-Problem gilt hier unverändert (Modul-Kommentar oben).
 * Muss mit `reviewPageUrl` in `apps/api/src/routes/workflow.ts` (dortiger
 * PR-Body-Link) übereinstimmen.
 */
export function wikiPageReviewHref(space: string, pageId: string): string {
  return `${wikiPageHref(space, pageId)}/review`
}

/** Versionsliste einer Seite (Seitenversionierung Etappe 2); mit `from` der
 *  Vergleich dieser Version gegen den heutigen Stand. */
/** A frozen release of a page (#40). */
export function wikiPageReleaseHref(space: string, pageId: string, version: string): string {
  return `${wikiPageHref(space, pageId)}/releases/${encodeURIComponent(version)}`
}

export function wikiPageVersionsHref(space: string, pageId: string, from?: string): string {
  const base = `${wikiPageHref(space, pageId)}/versions`
  return from ? `${base}?from=${encodeURIComponent(from)}` : base
}

/**
 * Href einer Mediendatei einer Seite (Bilder in `_media/`), z. B.
 * `mediaHref('home', '_media/diagram.png')` → `/media/home/diagram.png?ref=main`.
 * `pageId` wird als EIN Segment kodiert (wie bei den anderen Helfern —
 * Fallback-Ids enthalten Slashes), `relPath` dagegen segmentweise: seine
 * Slashes sind echte Pfadtrenner (`_media/<Name>`), keine kodierten Zeichen
 * einer opaken Id.
 *
 * Bugfix (Phase 2c Task 7, E2E Flow 3 — real beobachtet: weder das
 * bestehende Seed-Bild noch ein frisch hochgeladenes Draft-Bild luden im
 * Editor, beide 404): `GET /media/:pageId/*` (`apps/api/src/routes/media.ts`)
 * baut den Git-Pfad selbst als `<Seitenordner>/_media/<Wildcard>` — der
 * Wildcard-Teil der URL darf das `_media/`-Präfix aus der (unveränderten)
 * Markdown-Bildreferenz also NICHT mehr enthalten, sonst entsteht serverseitig
 * ein doppeltes `_media/_media/…` und `readFileBinary` wirft `NotFoundError`
 * (→ 404). Ein führendes `_media/`-Segment in `relPath` wird deshalb hier
 * entfernt — konsistent zu `index-space.ts`s eigenem Bild-Src-Rewriting für
 * die Leseansicht (`_media/arch.svg` → `/media/<id>/arch.svg`, s. dortiger
 * Kommentar), das denselben Server-Vertrag korrekt bedient.
 */
export function mediaHref(pageId: string, relPath: string, ref: 'main' | 'draft' = 'main'): string {
  const withoutMediaPrefix = relPath.replace(/^_media\//, '')
  const encodedRelPath = withoutMediaPrefix.split('/').map(encodeURIComponent).join('/')
  return `/media/${encodeURIComponent(pageId)}/${encodedRelPath}?ref=${encodeURIComponent(ref)}`
}

/**
 * API-Pfad des rohen Markdowns einer Seite (`GET /api/pages/:id/raw`,
 * `apps/api/src/routes/pages.ts`), z. B. `apiPageRawPath('home')` →
 * `/api/pages/home/raw`. `download: true` (Feature „Markdown-Export") hängt
 * `?download=1` an — der Server setzt dann zusätzlich `Content-Disposition:
 * attachment`, ohne den Parameter bleibt die Antwort der unveränderte
 * Interop-Endpunkt. Kodierung wie {@link wikiPageHref}.
 */
export function apiPageRawPath(pageId: string, opts?: { download?: boolean }): string {
  const base = `/api/pages/${encodeURIComponent(pageId)}/raw`
  return opts?.download ? `${base}?download=1` : base
}
