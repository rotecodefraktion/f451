import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ForgejoProvider, type RepoRef } from '@f451/git-provider'
import { startForgejo, type ForgejoTestInstance, type ForgejoTestUser } from '@f451/git-provider/testing'
import { buildApp } from '../src/app.js'
import { draftBranchName } from '../src/drafts/branch-name.js'
import { LOCK_TTL_MS } from '../src/drafts/lifecycle.js'
import { upsertProviderAccount } from '../src/auth/connect.js'
import { SESSION_COOKIE_NAME, createSession } from '../src/auth/sessions.js'
import { createDb, type Db } from '../src/db/client.js'
import { locks, pages, users } from '../src/db/schema.js'
import { indexSpace } from '../src/indexer/index-space.js'
import type { SpaceConfig } from '../src/spaces/config.js'
import { startPg, type PgTestInstance } from './helpers/pg-container.js'

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))
function fixtureBuffer(name: string): Buffer {
  return readFileSync(`${fixturesDir}${name}`)
}

/** Baut einen echten `multipart/form-data`-Request-Body (wie
 *  `drafts-media-routes.test.ts`) — keine zusätzliche Test-Dependency nötig. */
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
 * Draft-Lifecycle Ende-zu-Ende (Phase 2a Task 6, Abnahme-Kriterium der ganzen
 * Phase): EIN durchgehender Flow gegen die echte App-Komposition (`buildApp`,
 * kein handverdrahtetes Deps-Objekt) und echte Forgejo-/PG-Container — deckt
 * in Reihenfolge exakt den im Plan (`docs/superpowers/plans/2026-07-10-phase-2a-draft-backend.md`,
 * Task 6) verlangten Ablauf ab:
 *
 *   Draft anlegen → Lock heartbeaten → 2× speichern (2. mit korrektem neuem
 *   SHA, Git-Log zeigt echte Nutzer-Autorschaft) → externer Push auf den
 *   Draft-Branch (Konflikt) → Save mit dem jetzt veralteten SHA → 409 mit dem
 *   aktuellen (extern gepushten) Stand → Bild hochladen → Draft in der Suche
 *   (ref=draft) auffindbar → verwerfen → Branch/Index/Lock vollständig weg.
 *
 * Die einzelnen Bausteine (Berechtigungs-Gates, Medien-Validierung im Detail,
 * SVG-Sanitizing, Lock-Übernahme abgelaufener Locks usw.) sind bereits in den
 * Task-2/3/4/5-Testdateien granular abgedeckt — dieser Test dupliziert das
 * NICHT, sondern beweist, dass die Bausteine als Ganzes durch die echte
 * App-Verdrahtung (`buildApp`) zusammenspielen (Abnahme-Kriterien 1, 2 und 4
 * der Phase-2a-Abnahme).
 */
describe.sequential('Draft-Lifecycle Ende-zu-Ende (Phase 2a Task 6)', () => {
  let pg: PgTestInstance
  let forgejo: ForgejoTestInstance
  let handle: Awaited<ReturnType<typeof createDb>>
  let db: Db
  let serviceProvider: ForgejoProvider
  let repo: RepoRef
  let space: SpaceConfig
  let app: FastifyInstance

  let writer: ForgejoTestUser
  let external: ForgejoTestUser
  let externalProvider: ForgejoProvider
  const writerUserId = 'draft-lifecycle-writer'

  let writerSession: string

  const pageId = 'home'
  const pagePath = 'index.md'
  const branch = draftBranchName(pageId)

  beforeAll(async () => {
    ;[pg, forgejo] = await Promise.all([startPg(), startForgejo()])
    handle = createDb(pg.connectionString)
    db = handle.db
    await handle.migrate()

    // Service-Account-Provider (Indexer/Registry) — schreibt NIE selbst im
    // Rahmen dieses Tests, nur zum Seeden von main verwendet.
    serviceProvider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: forgejo.token })
    repo = await forgejo.createRepo('draft-lifecycle', { private: false })
    await serviceProvider.writeFile(
      repo,
      pagePath,
      '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv1\n',
      { branch: 'main', message: 'seed' },
    )

    space = {
      id: 'draft-lifecycle-space',
      name: 'Draft Lifecycle',
      provider: 'forgejo',
      owner: repo.owner,
      repo: repo.repo,
      defaultLang: 'de',
      repoRef: repo,
    }
    await indexSpace({ db, provider: serviceProvider }, space)

    // writer: der Nutzer, der über die App arbeitet (Session + Nutzer-Token).
    writer = await forgejo.createUser('draft-lifecycle-writer')
    await forgejo.addCollaborator(space.repoRef, writer.username, 'write')

    // external: ein ZWEITER Forgejo-Nutzer mit Schreibrecht, der NICHT über
    // die App geht, sondern direkt per Git auf den Draft-Branch pusht — steht
    // für einen externen Editor (CI, anderer Client, …), der den 409-Konflikt
    // provoziert (Plan Task 6, „Konflikt provozieren via externem Push").
    external = await forgejo.createUser('draft-lifecycle-extern')
    await forgejo.addCollaborator(space.repoRef, external.username, 'write')
    externalProvider = new ForgejoProvider({ baseUrl: forgejo.baseUrl, token: external.token })

    await db.insert(users).values([
      { id: writerUserId, email: 'writer@example.org', displayName: 'Writer' },
    ])
    await upsertProviderAccount(db, writerUserId, 'forgejo', writer.username, { accessToken: writer.token }, TOKEN_KEY)

    app = buildApp({
      databaseUrl: pg.connectionString,
      spaces: [space],
      providerRegistry: () => serviceProvider,
      forgejoBaseUrl: forgejo.baseUrl,
      auth: {
        tokenKey: TOKEN_KEY,
        insecureCookies: true,
        connect: { forgejo: { baseUrl: forgejo.baseUrl, clientId: 'x', clientSecret: 'y' } },
      },
    })
    await app.ready()

    writerSession = (await createSession(db, writerUserId)).id
  }, 240_000)

  afterAll(async () => {
    await app?.close()
    await handle?.close()
    await Promise.all([pg?.stop(), forgejo?.stop()])
  })

  it('kompletter Draft-Zyklus: anlegen → heartbeaten → speichern → externer Konflikt → 409 → Bild → Suche → verwerfen', async () => {
    // Erst HIER (innerhalb des Tests, nach `beforeAll`) gebildet — `writerSession`
    // steht erst nach dem Setup fest; ein `const` auf `describe`-Ebene würde
    // (wie ein früherer Fehlversuch dieses Tests zeigte) mit `undefined`
    // ausgewertet und liefe in ein stilles 401.
    const cookies = { [SESSION_COOKIE_NAME]: writerSession }

    // 1. Draft anlegen (POST) — vom main-HEAD abgeleitet, noch kein Lock.
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft`,
      cookies,
    })
    expect(createRes.statusCode).toBe(200)
    const created = createRes.json()
    expect(created.branch).toBe(branch)
    expect(created.content).toContain('v1')
    expect(created.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(created.lock).toBeNull()
    // Echter Effekt, nicht nur "kein Fehler": der Branch existiert wirklich in Git.
    await expect(serviceProvider.getHeadSha(repo, branch)).resolves.toBeTruthy()

    // 2. Lock heartbeaten (PUT /api/locks/:pageId).
    const lockBefore = Date.now()
    const lockRes = await app.inject({
      method: 'PUT',
      url: `/api/locks/${pageId}`,
      cookies,
    })
    expect(lockRes.statusCode).toBe(200)
    const lockBody = lockRes.json()
    expect(lockBody.heldBy).toBe('Writer')
    expect(new Date(lockBody.expiresAt).getTime()).toBeGreaterThan(lockBefore + LOCK_TTL_MS - 1000)
    // `mine` wird serverseitig gegen `req.user.id` berechnet — der eigene Lock ist "mine".
    expect(lockBody.mine).toBe(true)
    // Echter Effekt: die Draft-Antwort trägt jetzt denselben Lock.
    const getAfterLock = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies,
    })
    expect(getAfterLock.json().lock).toEqual({ user: 'Writer', heartbeatAt: expect.any(String), mine: true })

    // 3. Erster Save.
    const firstSaveRes = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies,
      payload: {
        content: '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nv2 (Entwurf)\n',
        baseSha: created.baseSha,
      },
    })
    expect(firstSaveRes.statusCode).toBe(200)
    const firstSave = firstSaveRes.json()
    expect(firstSave.newSha).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof firstSave.savedAt).toBe('string')
    const afterFirstSave = await serviceProvider.readFile(repo, pagePath, branch)
    expect(afterFirstSave.content).toContain('v2 (Entwurf)')

    // 4. Zweiter Save MIT dem korrekten neuen SHA aus dem ersten Save.
    const marker = 'Entwurfsmarker-Ende-zu-Ende'
    const secondSaveRes = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies,
      payload: {
        content: `---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\n${marker}\n`,
        baseSha: firstSave.newSha,
      },
    })
    expect(secondSaveRes.statusCode).toBe(200)
    const secondSave = secondSaveRes.json()
    expect(secondSave.newSha).toMatch(/^[0-9a-f]{40}$/)
    const afterSecondSave = await serviceProvider.readFile(repo, pagePath, branch)
    expect(afterSecondSave.content).toContain(marker)

    // Git-Log zeigt den Nutzer als echten Autor beider Save-Commits (kein Bot,
    // Plan Global Constraints/Abnahme-Kriterium 1). Die Historie enthält
    // zusätzlich den initialen Seed-Commit des Service-Accounts (der Branch
    // wurde vom main-HEAD abgeleitet) — `limit` grenzt beim Forgejo-Provider
    // NICHT auf die neuesten N Commits ein (Endpunkt ignoriert den Parameter
    // bei pfad-gefilterten Anfragen), daher werden hier gezielt die ZWEI
    // neuesten (newest-first) geprüft, nicht die ganze zurückgegebene Liste.
    const commitsAfterSaves = await serviceProvider.listCommits(repo, { ref: branch, path: pagePath })
    expect(commitsAfterSaves.length).toBeGreaterThanOrEqual(2)
    for (const commit of commitsAfterSaves.slice(0, 2)) {
      expect(commit.authorEmail).toBe(`${writer.username}@test.local`)
    }

    // 5. Externer Push auf den Draft-Branch (Konflikt provozieren) — EIN
    // ANDERER Nutzer schreibt direkt per Git, ohne über die App zu gehen.
    const beforeExternalPush = await serviceProvider.readFile(repo, pagePath, branch)
    expect(beforeExternalPush.sha).toBe(secondSave.newSha) // Vorbedingung: deterministischer Blob-SHA stimmt mit dem realen Git-Blob überein.
    const externalContent = '---\nid: home\ntitle: Home\nlang: de\n---\n# Home\n\nExterne Änderung (fremder Push)\n'
    await externalProvider.writeFile(repo, pagePath, externalContent, {
      branch,
      message: 'externe Änderung (simuliert einen fremden Push)',
      sha: beforeExternalPush.sha,
    })
    const afterExternalPush = await serviceProvider.readFile(repo, pagePath, branch)
    expect(afterExternalPush.content).toBe(externalContent)
    expect(afterExternalPush.sha).not.toBe(secondSave.newSha)

    // 6. Save MIT dem jetzt veralteten SHA (secondSave.newSha, vor dem
    // externen Push) → 409-Vertrag: aktueller Stand zurück, KEIN stilles
    // Überschreiben (Abnahme-Kriterium 2).
    const staleSaveRes = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/draft`,
      cookies,
      payload: { content: 'versuchter Overwrite, darf nicht ankommen', baseSha: secondSave.newSha },
    })
    expect(staleSaveRes.statusCode).toBe(409)
    const conflictBody = staleSaveRes.json()
    expect(conflictBody.error).toBeTruthy()
    expect(conflictBody.currentSha).toBe(afterExternalPush.sha)
    expect(conflictBody.currentContent).toBe(externalContent)
    // Kein Pfad überschreibt still: der Branch-Inhalt ist nach dem
    // gescheiterten Save unverändert der externe Stand.
    const afterFailedSave = await serviceProvider.readFile(repo, pagePath, branch)
    expect(afterFailedSave.content).toBe(externalContent)

    // 7. Bild hochladen.
    const { payload, contentType } = await multipartBody('Diagramm.png', fixtureBuffer('minimal.png'), 'image/png')
    const mediaRes = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/media`,
      cookies,
      headers: { 'content-type': contentType },
      payload,
    })
    expect(mediaRes.statusCode).toBe(200)
    expect(mediaRes.json()).toEqual({
      path: '_media/diagramm.png',
      markdown: '![](_media/diagramm.png)',
      kind: 'image',
    })
    const committedMedia = await serviceProvider.readFileBinary(repo, '_media/diagramm.png', branch)
    expect(committedMedia.content).toEqual(fixtureBuffer('minimal.png'))
    const mediaCommits = await serviceProvider.listCommits(repo, { ref: branch, path: '_media/diagramm.png', limit: 1 })
    expect(mediaCommits[0]?.authorEmail).toBe(`${writer.username}@test.local`)

    // 8. Draft in der Suche (ref=draft) auffindbar — der zuletzt ERFOLGREICH
    // gespeicherte Stand (Schritt 4) ist indexiert, der gescheiterte
    // Überschreibversuch aus Schritt 6 hat NICHT reindexiert.
    const draftSearchRes = await app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent(marker)}&ref=draft`,
      cookies,
    })
    expect(draftSearchRes.statusCode).toBe(200)
    const draftHits = draftSearchRes.json() as Array<{ id: string }>
    expect(draftHits.some((h) => h.id === pageId)).toBe(true)

    // 9. Verwerfen — Branch, Draft-Index-Zeilen (ref='draft') und Lock müssen
    // vollständig verschwinden (Abnahme-Kriterium der Phase, „alles weg").
    const discardRes = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}/draft`,
      cookies,
    })
    expect(discardRes.statusCode).toBe(204)

    // Branch weg.
    const getAfterDiscard = await app.inject({
      method: 'GET',
      url: `/api/pages/${pageId}/draft`,
      cookies,
    })
    expect(getAfterDiscard.statusCode).toBe(404)
    await expect(serviceProvider.getHeadSha(repo, branch)).rejects.toThrow()

    // Index-Zeilen (ref='draft') weg — direkte DB-Prüfung, nicht nur über die
    // (bereits durch den main-only-Vertrag gefilterte) Such-API.
    const draftIndexRows = await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.ref, 'draft')))
    expect(draftIndexRows).toHaveLength(0)

    // Lock weg.
    const lockRows = await db.select().from(locks).where(eq(locks.pageId, pageId))
    expect(lockRows).toHaveLength(0)

    // Die Draft-Suche findet den Marker jetzt auch folgerichtig nicht mehr.
    const draftSearchAfterDiscard = await app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent(marker)}&ref=draft`,
      cookies,
    })
    expect(draftSearchAfterDiscard.json()).toEqual([])

    // Test-Timeout (dritter `it()`-Parameter unten): ein einziger, durchgehender
    // Flow mit vielen Container-Roundtrips (Provider-Requests, ein externer
    // Push) — der vitest-Default (5 s) reicht unter Last nicht (beobachtet bei
    // `pnpm -r test`: mehrere gleichzeitige Forgejo-/PG-Container auf demselben
    // Podman-Host verlangsamen jeden einzelnen Request spürbar). Derselbe Grund,
    // aus dem `auth-lifecycle.test.ts` seinem einzigen großen `it()` einen
    // expliziten 240s-Rahmen gibt.
  }, 120_000)
})
