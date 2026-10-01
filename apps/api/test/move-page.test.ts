import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, NotFoundError, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64')

interface MovePageResponse {
  id: string
  space: string
  path: string
  movedCount: number
}

/**
 * `POST /api/pages/:id/move` (Phase 3.2, „Seite verschieben/umbenennen +
 * Wikilink-Rewrite + `_media`-Mitverschieben") — durchgehend über
 * `buildApp`/`app.inject()` gegen echten Forgejo- und PG-Container (Muster
 * `create-page.test.ts`/`delete-page.test.ts`): Gate-Kette, Zielpfad-
 * Ableitung (Rename/Move/Space-Wurzel/rekursiv mit Kindern), Kollision,
 * Draft-/Lock-Blockade, Wikilink-Rewrite (mit/ohne Alias, Titel-Ziel
 * unangetastet, kein Präfix-Teilmatch), `_media`-Mitkopieren, Zyklus-Schutz
 * und Idempotenz/Wiederaufnahme.
 */
describe.sequential('POST /api/pages/:id/move: Seite verschieben/umbenennen (Phase 3.2)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let provider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: FastifyInstance

  let writer: ForgejoTestUser
  let reader: ForgejoTestUser
  const writerUserId = 'mp-writer'
  const readerUserId = 'mp-reader'

  let writerSession: string
  let readerSession: string

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    provider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('move-page', { private: false })

    const seed = async (path: string, id: string, title: string, body?: string) => {
      await provider.writeFile(
        repo,
        path,
        `---\nid: ${id}\ntitle: ${title}\nlang: de\n---\n${body ?? `# ${title}\n`}`,
        { branch: 'main', message: 'seed' },
      )
    }

    await seed('index.md', 'home', 'Home')

    // Rename-Happy-Path.
    await seed('rename-mich/index.md', 'rename-mich', 'Rename Mich')

    // Rename NICHT rekursiv: nur die Primärseite bekommt den neuen Frontmatter-Titel,
    // ihre Unterseite behält ihren eigenen Titel.
    await seed('rename-mit-kind/index.md', 'rename-mit-kind', 'Rename Mit Kind')
    await seed('rename-mit-kind/kind/index.md', 'rename-mit-kind-kind', 'Unverändertes Kind')

    // Rekursiver Move (samt Kind + `_media`) + Ziel-Parent.
    await seed('ziel-eltern/index.md', 'ziel-eltern', 'Ziel Eltern')
    await seed('verschieb-mich/index.md', 'verschieb-mich', 'Verschieb Mich')
    await seed('verschieb-mich/kind/index.md', 'verschieb-mich-kind', 'Kind')
    await provider.writeFileBinary(repo, 'verschieb-mich/_media/bild.png', Buffer.from('fake-media-bytes'), {
      branch: 'main',
      message: 'seed media',
    })
    // Sibling mit überlappendem Pfad-Präfix (Sicherheitsnetz gegen Teilmatch).
    await seed('verschieb-mich-lang/index.md', 'verschieb-mich-lang', 'Verschieb Mich Lang')

    // Referenzierer: Alias-Wikilink, Wikilink ohne Alias, Titel-Wikilink (bleibt
    // unangetastet), plus Wikilink auf den Präfix-Sibling (bleibt unangetastet).
    await seed(
      'referenzierer/index.md',
      'referenzierer',
      'Referenzierer',
      '[[verschieb-mich|Alias Text]]\n\n[[verschieb-mich]]\n\n[[Verschieb Mich]]\n\n[[verschieb-mich-lang]]\n',
    )

    // Verschieben an die Space-Wurzel (`parentId: null`).
    await seed('eltern-x/index.md', 'eltern-x', 'Eltern X')
    await seed('eltern-x/wurzel-ziel/index.md', 'wurzel-ziel', 'Wurzel Ziel')

    // Kollision (main + draft-only).
    await seed('kollision-ziel/index.md', 'kollision-ziel-main', 'Kollision Ziel')
    await seed('kollision-quelle/index.md', 'kollision-quelle', 'Kollision Quelle')

    // Zyklus-Schutz.
    await seed('zyklus-eltern/index.md', 'zyklus-eltern', 'Zyklus Eltern')
    await seed('zyklus-eltern/kind/index.md', 'zyklus-eltern-kind', 'Zyklus Kind')

    // Draft-/Lock-Blockade.
    await seed('blockiert/index.md', 'blockiert', 'Blockiert')
    await seed('blockiert-eltern/index.md', 'blockiert-eltern', 'Blockiert Eltern')
    await seed('blockiert-eltern/kind/index.md', 'blockiert-eltern-kind', 'Blockiert Kind')
    await seed('gesperrt/index.md', 'gesperrt', 'Gesperrt')

    // Idempotenz/Wiederaufnahme.
    await seed('idempotenz-quelle/index.md', 'idempotenz-quelle', 'Idempotenz Quelle')

    // Unbekannte parentId.
    await seed('unbekannter-parent-quelle/index.md', 'unbekannter-parent-quelle', 'Unbekannter Parent Quelle')

    // --- Nachschärfung 1: `.order`-Pflege beim Move ---
    const seedOrder = async (dirPath: string, ids: string[]) => {
      await provider.writeFile(repo, `${dirPath}/.order`, `${ids.join('\n')}\n`, { branch: 'main', message: 'seed order' })
    }

    // Move MIT Eltern-Wechsel: id aus Quell-`.order` entfernen, an Ziel-`.order` anhängen.
    await seed('order-eltern-quelle/index.md', 'order-eltern-quelle', 'Order Eltern Quelle')
    await seed('order-eltern-quelle/kind-a/index.md', 'order-kind-a', 'Order Kind A')
    await seed('order-eltern-quelle/kind-b/index.md', 'order-kind-b', 'Order Kind B')
    await seedOrder('order-eltern-quelle', ['order-kind-b', 'order-kind-a'])
    await seed('order-eltern-ziel/index.md', 'order-eltern-ziel', 'Order Eltern Ziel')
    await seed('order-eltern-ziel/kind-c/index.md', 'order-kind-c', 'Order Kind C')
    await seedOrder('order-eltern-ziel', ['order-kind-c'])

    // Quell-`.order` wird nach Entfernung leer → Datei gelöscht; Ziel hat KEINE
    // `.order` → es wird KEINE neue angelegt (unsortiert/alphabetisch bleibt gültig).
    await seed('order-eltern-leer/index.md', 'order-eltern-leer', 'Order Eltern Leer')
    await seed('order-eltern-leer/solo-kind/index.md', 'order-solo-kind', 'Order Solo Kind')
    await seedOrder('order-eltern-leer', ['order-solo-kind'])

    // Rekursiver Move MIT verschachtelter `.order` (Unterseiten-Reihenfolge übersteht den Move).
    await seed('order-verschieb-mich/index.md', 'order-verschieb-mich', 'Order Verschieb Mich')
    await seed('order-verschieb-mich/kind1/index.md', 'order-verschieb-mich-kind1', 'Order VM Kind1')
    await seed('order-verschieb-mich/kind2/index.md', 'order-verschieb-mich-kind2', 'Order VM Kind2')
    await seedOrder('order-verschieb-mich', ['order-verschieb-mich-kind2', 'order-verschieb-mich-kind1'])

    // Reines Rename (derselbe Elternordner) — Eltern-`.order` bleibt unangetastet.
    await seed('order-rename-eltern/index.md', 'order-rename-eltern', 'Order Rename Eltern')
    await seed('order-rename-eltern/mich/index.md', 'order-rename-mich', 'Order Rename Mich')
    await seed('order-rename-eltern/sibling/index.md', 'order-rename-sibling', 'Order Rename Sibling')
    await seedOrder('order-rename-eltern', ['order-rename-mich', 'order-rename-sibling'])

    // --- Nachschärfung 2: relative Markdown-Links beim Move ---
    await seed('relativ-eltern-ziel/index.md', 'relativ-eltern-ziel', 'Relativ Eltern Ziel')
    await seed(
      'relativ-verschieb-mich/index.md',
      'relativ-verschieb-mich',
      'Relativ Verschieb Mich',
      '# Relativ Verschieb Mich\n\n[Zu Home](../index.md)\n',
    )
    await seed(
      'relativ-verschieb-mich/kind/index.md',
      'relativ-verschieb-mich-kind',
      'Relativ Kind',
      '# Relativ Kind\n\n[Zur Eltern](../index.md)\n',
    )
    // Sibling mit überlappendem Pfad-Präfix (Sicherheitsnetz gegen Teilmatch bei relativen Links).
    await seed('relativ-verschieb-mich-lang/index.md', 'relativ-verschieb-mich-lang', 'Relativ Verschieb Mich Lang')
    // Referenzierer mit relativen Links in mehreren Formen (mit/ohne `.md`, mit Anker,
    // Präfix-Sibling unangetastet, absolute URL unangetastet).
    await seed(
      'relativ-referenzierer/index.md',
      'relativ-referenzierer',
      'Relativ Referenzierer',
      '[Mit md](../relativ-verschieb-mich/index.md)\n\n'
        + '[Ohne md](../relativ-verschieb-mich)\n\n'
        + '[Mit Anker](../relativ-verschieb-mich/index.md#abschnitt)\n\n'
        + '[Sibling unangetastet](../relativ-verschieb-mich-lang/index.md)\n\n'
        + '[Absolute unangetastet](https://example.com/relativ-verschieb-mich)\n',
    )

    space = {
      id: 'move-page-space', name: 'Move Page', provider: 'forgejo',
      owner: repo.owner, repo: repo.repo, defaultLang: 'de', repoRef: repo,
    }
    await indexSpace({ db, provider }, space)

    writer = await forgejo.createUser('mp-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')
    reader = await forgejo.createUser('mp-reader')
    await forgejo.addCollaborator(space.repoRef, reader.username, 'read')

    await db.insert(users).values([
      { id: writerUserId, email: 'mp-writer@example.org', displayName: 'Writer' },
      { id: readerUserId, email: 'mp-reader@example.org', displayName: 'Reader' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)
    await upsertProviderAccount(db, readerUserId, 'forgejo', reader.username, { accessToken: reader.token }, TOKEN_KEY)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => provider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await app.ready()

    writerSession = (await createSession(db, writerUserId)).id
    readerSession = (await createSession(db, readerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  const cookiesOf = (session: string): Record<string, string> => ({ [SESSION_COOKIE_NAME]: session })

  it('ohne Session → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages/rename-mich/move', payload: { title: 'X' } })
    expect(res.statusCode).toBe(401)
  })

  it('unbekannte Seite → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/gibt-es-nicht/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Nur-Lese-Collaborator → 403 ohne connect-Hinweis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/rename-mich/move',
      cookies: cookiesOf(readerSession),
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBeTruthy()
    expect(body.action).toBeUndefined()
  })

  it('unbekannte parentId → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/unbekannter-parent-quelle/move',
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'gibt-es-nicht' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Umbenennen (Rename): neuer Pfad aus dem Titel, id unverändert, Frontmatter-Titel aktualisiert', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/rename-mich/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Neuer Titel' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MovePageResponse
    expect(body).toEqual({ id: 'rename-mich', space: space.id, path: 'neuer-titel/index.md', movedCount: 1 })

    await expect(provider.readFile(repo, 'rename-mich/index.md', 'main')).rejects.toBeInstanceOf(NotFoundError)
    const moved = await provider.readFile(repo, 'neuer-titel/index.md', 'main')
    // `id` bleibt stabil, aber der sichtbare Frontmatter-`title` wird auf den neuen
    // Titel aktualisiert (der Pfad-Slug allein ist bei id-basierten URLs kaum
    // sichtbar — "Umbenennen" muss daher auch den angezeigten Titel ändern).
    expect(moved.content).toContain('id: rename-mich')
    expect(moved.content).toContain('title: Neuer Titel')
    expect(moved.content).not.toContain('title: Rename Mich')
    // `lang` (ein weiteres bestehendes Frontmatter-Feld) bleibt beim Titel-Rewrite erhalten.
    expect(moved.content).toContain('lang: de')
  })

  it('Umbenennen mit Unterseite: NUR die Primärseite bekommt den neuen Titel, Kind unberührt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/rename-mit-kind/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Umbenannt Mit Kind' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MovePageResponse
    expect(body).toEqual({
      id: 'rename-mit-kind', space: space.id, path: 'umbenannt-mit-kind/index.md', movedCount: 2,
    })

    const movedParent = await provider.readFile(repo, 'umbenannt-mit-kind/index.md', 'main')
    expect(movedParent.content).toContain('id: rename-mit-kind')
    expect(movedParent.content).toContain('title: Umbenannt Mit Kind')

    const movedChild = await provider.readFile(repo, 'umbenannt-mit-kind/kind/index.md', 'main')
    // Die Id bleibt stabil, aber der Titel der Unterseite bleibt UNVERÄNDERT —
    // der neue Titel gilt nur für die direkt umbenannte Seite, nicht für rekursiv
    // mitverschobene Unterseiten (s. Modul-Kommentar `move-page.ts`).
    expect(movedChild.content).toContain('id: rename-mit-kind-kind')
    expect(movedChild.content).toContain('title: Unverändertes Kind')
    expect(movedChild.content).not.toContain('title: Umbenannt Mit Kind')
  })

  it('No-Op: Umbenennen auf denselben Titel → 200, movedCount 0, kein Commit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/rename-mich/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Neuer Titel' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'rename-mich', space: space.id, path: 'neuer-titel/index.md', movedCount: 0 })
  })

  it('Zyklus-Schutz: Ziel-Parent liegt im eigenen Unterbaum → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/zyklus-eltern/move',
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'zyklus-eltern-kind' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toBeTruthy()
  })

  it('Kollision gegen eine bestehende main-Seite → 409 mit deren pageId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/kollision-quelle/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Kollision Ziel' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().pageId).toBe('kollision-ziel-main')

    // Kein Teilschritt darf gelaufen sein — Quelle bleibt exakt am alten Pfad.
    await expect(provider.readFile(repo, 'kollision-quelle/index.md', 'main')).resolves.toBeTruthy()
  })

  it('Kollision gegen eine draft-only-Seite (main+draft-Prüfung) → 409 mit deren pageId', async () => {
    const draftOnly = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Kollision Draft Only' },
    })
    expect(draftOnly.statusCode).toBe(201)
    const draftOnlyId = (draftOnly.json() as { id: string }).id

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/kollision-quelle/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Kollision Draft Only' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().pageId).toBe(draftOnlyId)
  })

  it('Draft-Blockade: Seite selbst hat einen offenen Entwurf → 409 mit blockedPageIds', async () => {
    const draftRes = await app.inject({
      method: 'POST',
      url: '/api/pages/blockiert/draft',
      cookies: cookiesOf(writerSession),
    })
    expect(draftRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/blockiert/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Blockiert Neu' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { status: string; blockedPageIds: string[] }
    expect(body.blockedPageIds).toEqual(['blockiert'])

    // Kein Teilschritt darf gelaufen sein.
    await expect(provider.readFile(repo, 'blockiert/index.md', 'main')).resolves.toBeTruthy()
  })

  it('Draft-Blockade: eine UNTERSEITE hat einen offenen Entwurf → gesamter Move blockiert (409)', async () => {
    const draftRes = await app.inject({
      method: 'POST',
      url: '/api/pages/blockiert-eltern-kind/draft',
      cookies: cookiesOf(writerSession),
    })
    expect(draftRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/blockiert-eltern/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Blockiert Eltern Neu' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { blockedPageIds: string[] }
    expect(body.blockedPageIds).toContain('blockiert-eltern-kind')

    await expect(provider.readFile(repo, 'blockiert-eltern/index.md', 'main')).resolves.toBeTruthy()
  })

  it('Lock-Blockade (ohne Draft-Branch, nur aktiver Lock) → 409', async () => {
    await db.insert(users).values({ id: 'mp-locker', email: 'mp-locker@example.org', displayName: 'Locker' })
    await db.insert(locks).values({ pageId: 'gesperrt', userId: 'mp-locker', userName: 'Locker' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/gesperrt/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Gesperrt Neu' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { blockedPageIds: string[] }).blockedPageIds).toEqual(['gesperrt'])

    await db.delete(locks).where(eq(locks.pageId, 'gesperrt'))
  })

  it(
    'Rekursiver Move MIT Kindern + `_media` + Wikilink-Rewrite (Alias/ohne Alias/Titel-Ziel unangetastet/kein '
      + 'Präfix-Teilmatch), gebündelt in wenige Commits',
    async () => {
      // Gemessen am 2026-07-28: Über den Einzeldatei-Weg erzeugte der Move von
      // „Virtuelle Maschinen" (Unterseiten mit je zwei Dutzend
      // Bildschirmabzügen) 400 Commits und brauchte 177 Sekunden — der Browser
      // gab lange vorher auf und meldete dem Nutzer einen Fehlschlag, während
      // der Server unbeirrt weiterarbeitete und den Move korrekt abschloss.
      // Seitdem sammelt `movePage` in drei Sammel-Commits: kopieren, Links
      // nachziehen, aufräumen. Diese Zusage steht hier, weil sie sonst still
      // zurückgedreht werden kann — an der Funktion sähe man nichts, nur an
      // der Uhr.
      const commitsBefore = await provider.listCommits(repo, { ref: 'main', limit: 200 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/verschieb-mich/move',
        cookies: cookiesOf(writerSession),
        payload: { parentId: 'ziel-eltern' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MovePageResponse
      expect(body).toEqual({
        id: 'verschieb-mich', space: space.id, path: 'ziel-eltern/verschieb-mich/index.md', movedCount: 2,
      })

      // Alte Pfade weg, neue Pfade da (samt Kind).
      await expect(provider.readFile(repo, 'verschieb-mich/index.md', 'main')).rejects.toBeInstanceOf(NotFoundError)
      await expect(provider.readFile(repo, 'verschieb-mich/kind/index.md', 'main')).rejects.toBeInstanceOf(
        NotFoundError,
      )
      const movedParent = await provider.readFile(repo, 'ziel-eltern/verschieb-mich/index.md', 'main')
      expect(movedParent.content).toContain('id: verschieb-mich')
      // Reiner Move (kein `title` im Body): Frontmatter bleibt 1:1 unverändert,
      // inkl. Titel — byte-identisch bis auf den Pfad (s. Modul-Kommentar `move-page.ts`).
      expect(movedParent.content).toBe(
        `---\nid: verschieb-mich\ntitle: Verschieb Mich\nlang: de\n---\n# Verschieb Mich\n`,
      )
      const movedChild = await provider.readFile(repo, 'ziel-eltern/verschieb-mich/kind/index.md', 'main')
      expect(movedChild.content).toContain('id: verschieb-mich-kind')
      expect(movedChild.content).toContain('title: Kind')

      // `_media` mitverschoben.
      await expect(
        provider.readFileBinary(repo, 'verschieb-mich/_media/bild.png', 'main'),
      ).rejects.toBeInstanceOf(NotFoundError)
      const media = await provider.readFileBinary(repo, 'ziel-eltern/verschieb-mich/_media/bild.png', 'main')
      expect(media.content.toString()).toBe('fake-media-bytes')

      // Wikilink-Rewrite im Referenzierer.
      const referencer = await provider.readFile(repo, 'referenzierer/index.md', 'main')
      expect(referencer.content).toContain('[[ziel-eltern/verschieb-mich|Alias Text]]')
      expect(referencer.content).toContain('[[ziel-eltern/verschieb-mich]]')
      expect(referencer.content).not.toContain('[[verschieb-mich|Alias Text]]')
      expect(referencer.content).not.toContain('[[verschieb-mich]]\n')
      // Titel-Wikilink bleibt unangetastet (Design-Vorgabe: titelbasiert nicht anfassen).
      expect(referencer.content).toContain('[[Verschieb Mich]]')
      // Sibling mit überlappendem Präfix bleibt unangetastet (kein Teilmatch).
      expect(referencer.content).toContain('[[verschieb-mich-lang]]')

      // Sechs berührte Dateien (2 Seiten + 1 Medium kopieren, 1 Referenzierer
      // umschreiben, 3 alte löschen) — über den Einzelweg wären das sieben
      // Commits, gebündelt sind es höchstens drei.
      const commitsAfter = await provider.listCommits(repo, { ref: 'main', limit: 200 })
      expect(commitsAfter.length - commitsBefore.length).toBeLessThanOrEqual(3)
    },
    15_000,
  )

  it(
    '`.order`-Pflege bei Move MIT Elternwechsel: id aus Quell-`.order` entfernt, an Ziel-`.order` angehängt',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/order-kind-b/move',
        cookies: cookiesOf(writerSession),
        payload: { parentId: 'order-eltern-ziel' },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MovePageResponse).path).toBe('order-eltern-ziel/kind-b/index.md')

      // Quelle: id entfernt, verbleibende Geschwister-Reihenfolge bleibt erhalten.
      const sourceOrder = await provider.readFile(repo, 'order-eltern-quelle/.order', 'main')
      expect(sourceOrder.content).toBe('order-kind-a\n')

      // Ziel: id ans ENDE der bestehenden Reihenfolge angehängt.
      const targetOrder = await provider.readFile(repo, 'order-eltern-ziel/.order', 'main')
      expect(targetOrder.content).toBe('order-kind-c\norder-kind-b\n')
    },
  )

  it(
    '`.order`-Pflege: Quelle wird nach Entfernung leer → Datei gelöscht; Ziel ohne `.order` → keine neue angelegt',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/order-solo-kind/move',
        cookies: cookiesOf(writerSession),
        payload: { parentId: 'ziel-eltern' },
      })
      expect(res.statusCode).toBe(200)

      await expect(provider.readFile(repo, 'order-eltern-leer/.order', 'main')).rejects.toBeInstanceOf(NotFoundError)
      // `ziel-eltern` hatte nie eine `.order` — es wird KEINE für die eine
      // verschobene Seite angelegt (bleibt unsortiert/alphabetisch gültig).
      await expect(provider.readFile(repo, 'ziel-eltern/.order', 'main')).rejects.toBeInstanceOf(NotFoundError)
    },
  )

  it(
    'Rekursiver Move kopiert verschachtelte `.order`-Datei mit (Unterseiten-Reihenfolge übersteht den Move)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/order-verschieb-mich/move',
        cookies: cookiesOf(writerSession),
        payload: { parentId: 'ziel-eltern' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MovePageResponse
      expect(body).toEqual({
        id: 'order-verschieb-mich', space: space.id, path: 'ziel-eltern/order-verschieb-mich/index.md', movedCount: 3,
      })

      await expect(provider.readFile(repo, 'order-verschieb-mich/.order', 'main')).rejects.toBeInstanceOf(
        NotFoundError,
      )
      const movedOrder = await provider.readFile(repo, 'ziel-eltern/order-verschieb-mich/.order', 'main')
      // Reihenfolge der Unterseiten (Kind2 vor Kind1) bleibt exakt erhalten.
      expect(movedOrder.content).toBe('order-verschieb-mich-kind2\norder-verschieb-mich-kind1\n')

      await expect(
        provider.readFile(repo, 'ziel-eltern/order-verschieb-mich/kind1/index.md', 'main'),
      ).resolves.toBeTruthy()
      await expect(
        provider.readFile(repo, 'ziel-eltern/order-verschieb-mich/kind2/index.md', 'main'),
      ).resolves.toBeTruthy()
    },
  )

  it('Reines Rename (derselbe Elternordner) lässt die Eltern-`.order` unangetastet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/order-rename-mich/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Order Renamed' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as MovePageResponse).path).toBe('order-rename-eltern/order-renamed/index.md')

    // Die stabile id bleibt in der Eltern-`.order` gültig — keine Änderung nötig.
    const parentOrder = await provider.readFile(repo, 'order-rename-eltern/.order', 'main')
    expect(parentOrder.content).toBe('order-rename-mich\norder-rename-sibling\n')
  })

  it(
    'Relative Links: eingehende Referenzen (mit/ohne `.md`, mit Anker) werden auf den neuen Pfad umgeschrieben, '
      + 'Präfix-Sibling und absolute URL bleiben unangetastet',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pages/relativ-verschieb-mich/move',
        cookies: cookiesOf(writerSession),
        payload: { parentId: 'relativ-eltern-ziel' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MovePageResponse
      expect(body).toEqual({
        id: 'relativ-verschieb-mich',
        space: space.id,
        path: 'relativ-eltern-ziel/relativ-verschieb-mich/index.md',
        movedCount: 2,
      })

      const referencer = await provider.readFile(repo, 'relativ-referenzierer/index.md', 'main')
      // Mit `.md`-Suffix: Suffix-Stil bleibt erhalten, Pfad zeigt auf den neuen Ort.
      expect(referencer.content).toContain('[Mit md](../relativ-eltern-ziel/relativ-verschieb-mich/index.md)')
      // Ohne `.md`-Suffix: Verzeichnisform bleibt erhalten (kein `.md` angehängt).
      expect(referencer.content).toContain('[Ohne md](../relativ-eltern-ziel/relativ-verschieb-mich)')
      // Anker-Suffix bleibt über den Rewrite hinweg erhalten.
      expect(referencer.content).toContain(
        '[Mit Anker](../relativ-eltern-ziel/relativ-verschieb-mich/index.md#abschnitt)',
      )
      // Alte Ziele verschwinden vollständig aus dem Text.
      expect(referencer.content).not.toContain('](../relativ-verschieb-mich/index.md)')
      expect(referencer.content).not.toContain('](../relativ-verschieb-mich)\n')
      expect(referencer.content).not.toContain('](../relativ-verschieb-mich/index.md#abschnitt)')
      // Sibling mit überlappendem Pfad-Präfix bleibt unangetastet (kein Teilmatch).
      expect(referencer.content).toContain('[Sibling unangetastet](../relativ-verschieb-mich-lang/index.md)')
      // Absolute URL bleibt unangetastet.
      expect(referencer.content).toContain('[Absolute unangetastet](https://example.com/relativ-verschieb-mich)')
    },
  )

  it(
    'Relative Links INNERHALB der bewegten Seite(n): eigener Link auf ein unbewegtes Ziel wird neu berechnet, '
      + 'Kind-Link auf die (mitbewegte) Eltern-Seite bleibt unverändert korrekt',
    async () => {
      // Die bewegte Primärseite selbst verlinkt relativ auf die (unbewegte) Startseite —
      // der relative Pfad muss von der NEUEN Position aus neu berechnet werden.
      const moved = await provider.readFile(repo, 'relativ-eltern-ziel/relativ-verschieb-mich/index.md', 'main')
      expect(moved.content).toContain('[Zu Home](../../index.md)')

      // Das mitverschobene Kind verlinkt relativ auf seine eigene (ebenfalls
      // mitbewegte) Elternseite — der relative Offset zwischen beiden bleibt durch
      // die Präfix-Verschiebung unverändert gültig, es darf KEIN Rewrite auf einen
      // anderen (falschen) Pfad erfolgen.
      const movedChild = await provider.readFile(
        repo,
        'relativ-eltern-ziel/relativ-verschieb-mich/kind/index.md',
        'main',
      )
      expect(movedChild.content).toContain('[Zur Eltern](../index.md)')
    },
  )

  it('Verschieben an die Space-Wurzel (`parentId: null`)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/wurzel-ziel/move',
      cookies: cookiesOf(writerSession),
      payload: { parentId: null },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MovePageResponse
    expect(body).toEqual({ id: 'wurzel-ziel', space: space.id, path: 'wurzel-ziel/index.md', movedCount: 1 })
    await expect(provider.readFile(repo, 'eltern-x/wurzel-ziel/index.md', 'main')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await expect(provider.readFile(repo, 'wurzel-ziel/index.md', 'main')).resolves.toBeTruthy()
  })

  it('Idempotenz/Wiederaufnahme: Zielpfad existiert bereits (simulierter Teil-Erfolg) → Move schließt trotzdem ab', async () => {
    const source = await provider.readFile(repo, 'idempotenz-quelle/index.md', 'main')
    // Simuliert einen bereits abgeschlossenen Kopier-Schritt aus einem früheren,
    // abgebrochenen Lauf (Design-Vorgabe: „Existiert das Ziel schon → überspringen").
    await provider.writeFile(repo, 'idempotenz-ziel/index.md', source.content, {
      branch: 'main',
      message: 'simulate partial move',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/idempotenz-quelle/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Idempotenz Ziel' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MovePageResponse
    expect(body).toEqual({ id: 'idempotenz-quelle', space: space.id, path: 'idempotenz-ziel/index.md', movedCount: 1 })

    await expect(provider.readFile(repo, 'idempotenz-quelle/index.md', 'main')).rejects.toBeInstanceOf(NotFoundError)
    const target = await provider.readFile(repo, 'idempotenz-ziel/index.md', 'main')
    expect(target.content).toContain('id: idempotenz-quelle')

    // Erneuter Aufruf (Seite jetzt unter neuem Pfad/Id-Fallback bekannt über
    // dieselbe stabile Id) — bereits am Ziel, No-Op.
    const again = await app.inject({
      method: 'POST',
      url: '/api/pages/idempotenz-quelle/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Idempotenz Ziel' },
    })
    expect(again.statusCode).toBe(200)
    expect((again.json() as MovePageResponse).movedCount).toBe(0)
  })

  it('Draft-only-Seite (nie released) → 404 (nichts auf main zu verschieben)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookiesOf(writerSession),
      payload: { space: space.id, title: 'Nie Released Move' },
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as { id: string }

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${encodeURIComponent(created.id)}/move`,
      cookies: cookiesOf(writerSession),
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Ungültiger Titel (leerer Slug) → 400, kein Commit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/eltern-x/move',
      cookies: cookiesOf(writerSession),
      payload: { title: '!!!' },
    })
    expect(res.statusCode).toBe(400)
    await expect(provider.readFile(repo, 'eltern-x/index.md', 'main')).resolves.toBeTruthy()
  })

  it('Space-Root-Seite umbenennen (title) → 400, VOR jedem Schreibvorgang abgelehnt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/home/move',
      cookies: cookiesOf(writerSession),
      payload: { title: 'Neue Startseite' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toBeTruthy()

    // Kein Teilschritt darf gelaufen sein — Wurzelseite bleibt exakt am alten Pfad/Titel.
    const root = await provider.readFile(repo, 'index.md', 'main')
    expect(root.content).toContain('title: Home')
  })

  it('Space-Root-Seite verschieben (parentId) → 400, VOR jedem Schreibvorgang abgelehnt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages/home/move',
      cookies: cookiesOf(writerSession),
      payload: { parentId: 'eltern-x' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toBeTruthy()

    const root = await provider.readFile(repo, 'index.md', 'main')
    expect(root.content).toContain('title: Home')
    await expect(provider.readFile(repo, 'eltern-x/index.md', 'main')).resolves.toBeTruthy()
  })
})
