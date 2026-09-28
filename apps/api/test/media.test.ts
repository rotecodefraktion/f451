import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')

// 1x1-Pixel transparentes PNG — kleinstmögliches valides Bild für den Bytes-Vergleich.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

// Minimales SVG für den Indexer-URL-Regressionstest (Bild-src mit `_media/`-Präfix).
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')

// Minimales PDF (nur die Magic-Bytes-Signatur relevant) für den Dokument-Anhang-
// Auslieferungstest (Content-Type/Content-Disposition, s. u.).
const PDF_BYTES = Buffer.from('%PDF-1.7\n%%EOF\n')

/** Pfadsegmente einzeln encoden, Slashes erhalten (wie `ForgejoProvider` intern). */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

/** Baut einen echten `multipart/form-data`-Request-Body (Feld `file`) — wie
 *  `drafts-media-routes.test.ts`, keine zusätzliche Test-Dependency nötig. */
async function multipartBody(
  filename: string,
  buffer: Buffer,
  mimetype: string,
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), filename)
  const req = new Request('http://upload.local/', { method: 'POST', body: form })
  const payload = Buffer.from(await req.arrayBuffer())
  const contentType = req.headers.get('content-type')!
  return { payload, contentType }
}

/**
 * Legt eine Binärdatei direkt über die rohe Forgejo-Contents-API an.
 * `GitProvider.writeFile` ist bewusst Text-only (UTF-8-Encoding, siehe
 * `ForgejoProvider.writeFile`) und daher zum Seeden echter Bild-Bytes
 * ungeeignet — dasselbe Muster wie `deleteFile` in lifecycle.test.ts für
 * Operationen, die der GitProvider-Vertrag nicht abbildet.
 */
async function writeBinaryFile(
  forgejo: ForgejoTestInstance,
  repo: RepoRef,
  path: string,
  bytes: Buffer,
): Promise<void> {
  const res = await fetch(
    `${forgejo.baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}`,
    {
      method: 'POST',
      headers: { Authorization: `token ${forgejo.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'main', message: `seed: ${path}`, content: bytes.toString('base64') }),
    },
  )
  if (!res.ok) {
    throw new Error(`Binärdatei "${path}" anlegen fehlgeschlagen (${res.status}): ${await res.text()}`)
  }
}

describe.sequential('Media-Auslieferung: GET /media/:pageId/*', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider

  let space: SpaceConfig // öffentlich, für appOpen und den Reader zugänglich
  let privateSpace: SpaceConfig // privat, für den Reader NICHT zugänglich

  let appOpen: FastifyInstance
  let appAuth: FastifyInstance
  let readerSession: string
  let writerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })

    const repo = await forgejo.createRepo('media', { private: false })
    const repoPrivate = await forgejo.createRepo('media-privat', { private: true })

    // Wurzelseite: Bild liegt unter `_media/` direkt (dirname('index.md') === '.').
    // Referenziert zusätzlich ein Bild MIT `_media/`-Präfix im Markdown-src (Indexer-
    // Regression: das Präfix muss vor dem Bau der /media-URL gestrippt werden, siehe
    // resolveImage in index-space.ts), damit die erzeugte URL zu dieser Route passt.
    await provider.writeFile(
      repo,
      'index.md',
      '---\nid: home\ntitle: Start\nlang: de\n---\n# Start\n\n![Architektur](_media/arch.drawio.svg)\n',
      { branch: 'main', message: 'seed: index.md' },
    )
    await writeBinaryFile(forgejo, repo, '_media/logo.png', PNG_BYTES)
    await writeBinaryFile(forgejo, repo, '_media/arch.drawio.svg', SVG_BYTES)

    // Verschachtelte Seite: Bild liegt unter `betrieb/_media/`.
    await provider.writeFile(
      repo,
      'betrieb/index.md',
      '---\nid: betrieb\ntitle: Betrieb\nlang: de\n---\n# Betrieb\n',
      { branch: 'main', message: 'seed: betrieb/index.md' },
    )
    await writeBinaryFile(forgejo, repo, 'betrieb/_media/foto.png', PNG_BYTES)
    // Nicht-Bild-Datei (unbekannte Extension) für den Download-Fall.
    await writeBinaryFile(forgejo, repo, 'betrieb/_media/daten.bin', Buffer.from([0x01, 0x02, 0x03]))
    // Dokument-Anhang (bekannte Extension, aber kein Bild) für den Content-Type-/
    // Content-Disposition-Test (Editor-Erweiterung „Datei-Anhänge").
    await writeBinaryFile(forgejo, repo, 'betrieb/_media/handbuch.pdf', PDF_BYTES)

    // Seite OHNE Frontmatter-`id` (Bug-Regression): fällt auf die Id
    // `path:<spaceId>/<filePath>` zurück (`derivePageId`, index-space.ts) —
    // mit Slashes. Deckt live gemeldeten Bug ab: unkodiert in der Media-URL
    // bindet `/media/:pageId/*` nur den Teil vor dem nächsten `/` als
    // `pageId`, der Rest landet im Wildcard → 404/falsches Bild.
    await provider.writeFile(
      repo,
      'ohne-id/index.md',
      '---\ntitle: Ohne Id\nlang: de\n---\n# Ohne Id\n\n![Diagramm](_media/diagramm.svg)\n',
      { branch: 'main', message: 'seed: ohne-id/index.md' },
    )
    await writeBinaryFile(forgejo, repo, 'ohne-id/_media/diagramm.svg', SVG_BYTES)

    await provider.writeFile(repoPrivate, 'index.md', '---\nid: privat\ntitle: Privat\nlang: de\n---\n# Privat\n', {
      branch: 'main',
      message: 'seed: index.md',
    })
    await writeBinaryFile(forgejo, repoPrivate, '_media/geheim.png', PNG_BYTES)

    space = {
      id: 'media-space', name: 'Media', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    privateSpace = {
      id: 'privat-space', name: 'Privat', provider: 'forgejo',
      owner: repoPrivate.owner, repo: repoPrivate.repo, defaultLang: 'de', repoRef: repoPrivate,
    }

    await indexSpace({ db, provider }, space)
    await indexSpace({ db, provider }, privateSpace)

    appOpen = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space, privateSpace],
      providerRegistry: () => provider,
    })
    await appOpen.ready()

    appAuth = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space, privateSpace],
      providerRegistry: () => provider,
      // Wie die Service-Account-Registry, unabhängig von `auth.connect.forgejo`
      // (Phase 2a Task 2, Konsistenz-Auflage aus dem Task-1-Review).
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await appAuth.ready()

    const reader = await forgejo.createUser('media-reader')
    const readerUserId = 'media-reader-id'
    await db.insert(users).values({ id: readerUserId, email: 'reader@example.org', displayName: 'Reader' })
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)
    readerSession = (await createSession(db, readerUserId)).id

    // Schreibberechtigter Nutzer (Task 1, `?ref=draft`-Gate) — braucht echtes
    // Schreibrecht auf `space.repoRef`, damit er einen Draft anlegen und
    // Medien hochladen kann.
    const writer = await forgejo.createUser('media-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    const writerUserId = 'media-writer-id'
    await db.insert(users).values({ id: writerUserId, email: 'writer@example.org', displayName: 'Writer' })
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    writerSession = (await createSession(db, writerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await appOpen?.close()
    await appAuth?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  describe('ohne Auth (offen)', () => {
    it('liefert ein Bild von der Wurzelseite byte-identisch mit passendem Content-Type und Sicherheits-Headern', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/home/logo.png' })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(PNG_BYTES)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
      // Leseansicht-Frische (Bugfix): main revalidiert per ETag statt fixem
      // `max-age` — sonst zeigt der Browser eine geänderte Datei bis zu 5 min
      // veraltet an (die gerenderte URL bleibt identisch, kein Cache-Bust).
      expect(res.headers['cache-control']).toBe('private, no-cache')
      expect(res.headers['etag']).toBeTruthy()
      // Regression (Task 4, Spec §7): der globale `onSend`-Hook (app.ts) setzt
      // Sicherheits-Header NUR, wenn sie noch fehlen — die von dieser Route
      // explizit gesetzten `X-Content-Type-Options`/`Content-Security-Policy`
      // bleiben oben unverändert (KEIN Duplikat/Überschreiben durch den Hook,
      // Fastify würde einen doppelt gesetzten Header als Array serialisieren).
      // `Referrer-Policy` setzt NUR der globale Hook (die Route selbst nicht) —
      // landet also unverändert auch auf der Media-Antwort.
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    })

    it(
      'Indexer-URL-Regression: die vom Indexer aus `_media/arch.drawio.svg` erzeugte ' +
        'src-URL ist über die Route byte-identisch abrufbar (Präfix korrekt gestrippt)',
      async () => {
        const homePage = (
          await db.select().from(pages).where(and(eq(pages.id, 'home'), eq(pages.ref, 'main')))
        )[0]!
        expect(homePage.htmlRendered).toContain('src="/media/home/arch.drawio.svg"')

        const res = await appOpen.inject({ method: 'GET', url: '/media/home/arch.drawio.svg' })
        expect(res.statusCode).toBe(200)
        expect(res.rawPayload).toEqual(SVG_BYTES)
        expect(res.headers['content-type']).toBe('image/svg+xml')
      },
    )

    it(
      'Bug-Regression: Seite ohne Frontmatter-id (Fallback-Id `path:<space>/<datei>` mit Slashes) → ' +
        'Media-URL korrekt kodiert erzeugt UND über die Route mit encodeURIComponent(pageId) aufgelöst',
      async () => {
        const page = (
          await db.select().from(pages).where(and(eq(pages.path, 'ohne-id/index.md'), eq(pages.ref, 'main')))
        )[0]!
        expect(page.id).toBe(`path:${space.id}/ohne-id/index.md`)
        // buildResolveImage muss die (Slash-haltige) pageId kodieren, sonst
        // bindet find-my-way beim Rendern der Route nur den Teil vor dem
        // nächsten `/` als :pageId.
        expect(page.htmlRendered).toContain(`src="/media/${encodeURIComponent(page.id)}/diagramm.svg"`)

        // find-my-way dekodiert %2F NICHT als Segmenttrenner — der gesamte
        // kodierte String landet unverändert (dekodiert) in :pageId.
        const res = await appOpen.inject({
          method: 'GET',
          url: `/media/${encodeURIComponent(page.id)}/diagramm.svg`,
        })
        expect(res.statusCode).toBe(200)
        expect(res.rawPayload).toEqual(SVG_BYTES)
        expect(res.headers['content-type']).toBe('image/svg+xml')
      },
    )

    it('liefert ein Bild einer verschachtelten Seite aus deren _media-Unterordner', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/betrieb/foto.png' })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(PNG_BYTES)
      expect(res.headers['content-type']).toBe('image/png')
    })

    it('unbekannte Extension → application/octet-stream + Content-Disposition attachment mit filename', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/betrieb/daten.bin' })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(Buffer.from([0x01, 0x02, 0x03]))
      expect(res.headers['content-type']).toBe('application/octet-stream')
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="daten.bin"; filename*=UTF-8\'\'daten.bin',
      )
      // Sicherheits-Header gelten auch für den Download-Fall.
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    })

    it('Dokument-Anhang (PDF): korrekter Content-Type UND Content-Disposition attachment mit filename (kein Inline-Rendering)', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/betrieb/handbuch.pdf' })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(PDF_BYTES)
      expect(res.headers['content-type']).toBe('application/pdf')
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="handbuch.pdf"; filename*=UTF-8\'\'handbuch.pdf',
      )
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    })

    it('unbekannte Seite → 404', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/nicht-vorhanden/logo.png' })
      expect(res.statusCode).toBe(404)
    })

    it('Traversal-Versuch im Wildcard (..) → 404 (der eigentliche Guard ist in media-guards.test.ts abgedeckt, '
      + 'da app.inject() den Pfad bereits vor dem Routing normalisiert)', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/home/../index.md' })
      expect(res.statusCode).toBe(404)
    })

    it('fehlende Datei bei bekannter Seite → 404', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/home/gibt-es-nicht.png' })
      expect(res.statusCode).toBe(404)
    })

    it('?ref=draft ohne Auth-Wiring → 404 (fail-closed: kein Nutzer, dessen Schreibrecht geprüft werden könnte)', async () => {
      const res = await appOpen.inject({ method: 'GET', url: '/media/home/logo.png?ref=draft' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('mit Auth', () => {
    it('ohne Session → 401', async () => {
      const res = await appAuth.inject({ method: 'GET', url: '/media/home/logo.png' })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('session')
    })

    it('mit Session und Zugriff auf den Space → 200, byte-identisch', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: '/media/home/logo.png',
        cookies: { [SESSION_COOKIE_NAME]: readerSession },
      })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(PNG_BYTES)
    })

    it('mit Session ohne Zugriff auf den (privaten) Space → 404 (kein Existenz-Orakel)', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: '/media/privat/geheim.png',
        cookies: { [SESSION_COOKIE_NAME]: readerSession },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  // Task 1 (Phase 2c-Vorarbeiten): `?ref=draft` liest vom Draft-Branch statt
  // main — nötig, damit frisch hochgeladene Draft-Bilder im Editor rendern,
  // BEVOR der Draft gespeichert/gemerged ist. Gate ist Schreibrecht
  // (konsistent zur Draft-Suche, `search.ts`), NICHT Leserecht.
  describe('?ref=draft (Task 1: Draft-Medien-Auslieferung)', () => {
    const draftPageId = 'home'
    const draftOnlyFilename = 'nur-im-draft.png'

    it('Vorbereitung: Writer legt den Draft an und lädt ein NUR dort existierendes Bild hoch', async () => {
      const openRes = await appAuth.inject({
        method: 'POST',
        url: `/api/pages/${draftPageId}/draft`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(openRes.statusCode).toBe(200)

      const { payload, contentType } = await multipartBody(draftOnlyFilename, PNG_BYTES, 'image/png')
      const uploadRes = await appAuth.inject({
        method: 'POST',
        url: `/api/pages/${draftPageId}/draft/media`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
        headers: { 'content-type': contentType },
        payload,
      })
      expect(uploadRes.statusCode).toBe(200)
      expect(uploadRes.json().path).toBe(`_media/${draftOnlyFilename}`)
    })

    it('Schreibberechtigter Nutzer: liefert das frisch hochgeladene Draft-Bild byte-identisch', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${draftPageId}/${draftOnlyFilename}?ref=draft`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(PNG_BYTES)
      expect(res.headers['content-type']).toBe('image/png')
    })

    it('dasselbe Bild ist auf main NICHT sichtbar (ohne ref-Parameter) — Lese-API bleibt main-only', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${draftPageId}/${draftOnlyFilename}`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(res.statusCode).toBe(404)
    })

    it('Nur-Lese-Nutzer → 404 bei ref=draft (Gate ist Schreibrecht, kein Existenz-Orakel: identisch zu unbekannter Seite)', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${draftPageId}/${draftOnlyFilename}?ref=draft`,
        cookies: { [SESSION_COOKIE_NAME]: readerSession },
      })
      expect(res.statusCode).toBe(404)
    })

    it('ohne Session → 401 (Schutz-Matrix greift vor dem ref=draft-Gate)', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${draftPageId}/${draftOnlyFilename}?ref=draft`,
      })
      expect(res.statusCode).toBe(401)
    })
  })

  // Fix Review-Befund 2 (Phase 2d Task 5, Fix-Runde 1): Draft-only-Seiten
  // (`POST /api/pages`, noch nie released) haben KEINE `ref='main'`-Zeile —
  // vorher suchte der Seiten-Lookup hier hart nach `ref='main'`, sodass
  // `GET /media/:pageId/*?ref=draft` für so eine Seite IMMER 404 lieferte,
  // obwohl der Upload (`POST /api/pages/:id/draft/media`) funktioniert:
  // hochgeladene Bilder blieben im Editor unsichtbar.
  describe('Draft-only-Seite (Fix Review-Befund 2: Media-Lookup-Fallback)', () => {
    let draftOnlyPageId: string
    const filename = 'frisch.png'

    it('Vorbereitung: neue Seite anlegen (Draft-only) und ein Bild in ihren Entwurf hochladen', async () => {
      const createRes = await appAuth.inject({
        method: 'POST',
        url: '/api/pages',
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
        payload: { space: space.id, title: 'Frisch Angelegt' },
      })
      expect(createRes.statusCode).toBe(201)
      draftOnlyPageId = createRes.json().id

      const { payload, contentType } = await multipartBody(filename, PNG_BYTES, 'image/png')
      const uploadRes = await appAuth.inject({
        method: 'POST',
        url: `/api/pages/${encodeURIComponent(draftOnlyPageId)}/draft/media`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
        headers: { 'content-type': contentType },
        payload,
      })
      expect(uploadRes.statusCode).toBe(200)
    })

    it('?ref=draft mit Schreibrecht liefert die Bytes (vorher: 404, weil der Lookup nur main kannte)', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${encodeURIComponent(draftOnlyPageId)}/${filename}?ref=draft`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload).toEqual(PNG_BYTES)
      expect(res.headers['content-type']).toBe('image/png')
    })

    it('ohne Schreibrecht → 404 (Gate bleibt Schreibrecht, fail-closed, unverändert)', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${encodeURIComponent(draftOnlyPageId)}/${filename}?ref=draft`,
        cookies: { [SESSION_COOKIE_NAME]: readerSession },
      })
      expect(res.statusCode).toBe(404)
    })

    it('?ref=main → 404 (kein main-Stand für eine Draft-only-Seite, Lese-API bleibt main-only)', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${encodeURIComponent(draftOnlyPageId)}/${filename}?ref=main`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(res.statusCode).toBe(404)
    })

    it('ohne ref-Parameter (Default main) → 404', async () => {
      const res = await appAuth.inject({
        method: 'GET',
        url: `/media/${encodeURIComponent(draftOnlyPageId)}/${filename}`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  // Task 1 (Phase 3e): Draft-Medien ändern sich bei jedem Diagramm-/Media-
  // Speichern — ein `Cache-Control: private, max-age=300` würde einem
  // Client/Browser erlauben, eine veraltete Fassung bis zu 5 Minuten weiter
  // anzuzeigen (genau der Fall, den Task 3 mit sofortigem Neu-Rendering nach
  // dem Speichern vermeiden will). main bleibt unverändert 5 min cachebar.
  describe('Cache-Control (Task 1, Phase 3e: Draft-Media ohne Cache)', () => {
    const pageId = 'home'
    const filename = 'logo.png'

    it('ref=draft liefert Cache-Control: no-store, ref=main revalidiert per ETag/no-cache', async () => {
      const openRes = await appAuth.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/draft`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(openRes.statusCode).toBe(200)

      const draftRes = await appAuth.inject({
        method: 'GET',
        url: `/media/${pageId}/${filename}?ref=draft`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(draftRes.statusCode).toBe(200)
      expect(draftRes.headers['cache-control']).toBe('no-store')

      const mainRes = await appAuth.inject({
        method: 'GET',
        url: `/media/${pageId}/${filename}`,
        cookies: { [SESSION_COOKIE_NAME]: writerSession },
      })
      expect(mainRes.statusCode).toBe(200)
      // Bugfix Leseansicht-Frische: statt `max-age=300` (bis zu 5 min veraltet)
      // wird content-adressiert per ETag revalidiert.
      expect(mainRes.headers['cache-control']).toBe('private, no-cache')
      expect(mainRes.headers['etag']).toBeTruthy()
    })

    // Bugfix Leseansicht-Frische (Regression): der ETag ist der Git-Blob-SHA der
    // Media-Datei (echter Content-Hash). Eine erneute Anfrage mit passendem
    // `If-None-Match` wird per `304 Not Modified` ohne Body bedient — sofortige
    // Frische bei Änderung (neuer SHA → neuer ETag → 200 mit neuen Bytes) UND
    // Bandbreiten-Effizienz bei Unverändertem.
    it('ref=main: If-None-Match mit passendem ETag → 304 ohne Body', async () => {
      const first = await appOpen.inject({ method: 'GET', url: `/media/${pageId}/${filename}` })
      expect(first.statusCode).toBe(200)
      const etag = first.headers['etag'] as string
      expect(etag).toBeTruthy()

      const revalidated = await appOpen.inject({
        method: 'GET',
        url: `/media/${pageId}/${filename}`,
        headers: { 'if-none-match': etag },
      })
      expect(revalidated.statusCode).toBe(304)
      expect(revalidated.rawPayload.length).toBe(0)
      expect(revalidated.headers['etag']).toBe(etag)

      // Nicht passender ETag (z. B. nach Datei-Änderung) → 200 mit den Bytes.
      const changed = await appOpen.inject({
        method: 'GET',
        url: `/media/${pageId}/${filename}`,
        headers: { 'if-none-match': '"veraltet"' },
      })
      expect(changed.statusCode).toBe(200)
      expect(changed.rawPayload).toEqual(PNG_BYTES)
    })
  })
})
