/**
 * Schreib-Tools (Phase B).
 *
 * Zwei Eigenschaften bestimmen den Zuschnitt dieser Tools:
 *
 * 1. **Schreiben läuft immer über den Review-Workflow.** Es gibt keinen Weg,
 *    direkt auf die veröffentlichte Fassung zu schreiben — Änderungen landen
 *    in einem Draft-Branch, gehen durch eine Review und werden erst dann
 *    zusammengeführt. Das gilt für Agenten wie für Menschen.
 *
 * 2. **Es wird unter dem Konto des Nutzers committet.** Der API-Token setzt nur
 *    `req.user`; den eigentlichen Commit macht die API mit dem hinterlegten
 *    Forgejo-Token dieses Nutzers. Ohne verknüpftes Konto scheitert jeder
 *    Schreibversuch mit 403 — kein Fehler, sondern eine Voraussetzung, die nur
 *    ein Mensch im Browser erfüllen kann (in `client.ts` entsprechend gemappt).
 *
 * **SHA-Vertrag:** `PUT /api/pages/:id/draft` verlangt den `baseSha` des Standes,
 * auf dem die Änderung aufsetzt, und antwortet mit 409, wenn der Draft sich
 * zwischenzeitlich bewegt hat. Da dieser Dienst zustandslos ist (s. `server.ts`),
 * kann er den SHA nicht über Requests hinweg mitführen. Statt den Agenten die
 * Buchführung machen zu lassen, ist `baseSha` optional: Fehlt er, holt
 * `update_page_draft` den aktuellen Stand selbst. Ein 409 wird dabei bewusst
 * NICHT automatisch aufgelöst — das würde fremde Änderungen still überschreiben.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { tokenFromExtra } from '../auth.js'
import { apiRequest } from '../client.js'
import { guard } from './read.js'

/** Antwort von `POST /api/pages/:id/draft` — öffnet bzw. erzeugt den Draft. */
interface DraftState {
  branch: string
  baseSha: string
  content: string
  lock: { user: string; heartbeatAt: string; mine: boolean } | null
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    'create_page',
    {
      title: 'Neue Seite anlegen',
      description:
        'Legt eine neue Seite als Draft an (noch nicht veröffentlicht) und liefert `id`, `path`, `branch`, ' +
        '`baseSha` und den Startinhalt zurück. Danach mit update_page_draft den Inhalt schreiben, ' +
        'dann request_review. Voraussetzung: Token mit Scope "write" und ein verbundenes Forgejo-/GitHub-Konto.',
      inputSchema: {
        space: z.string().min(1).describe('Space-ID, in der die Seite entstehen soll.'),
        title: z.string().min(1).describe('Titel der neuen Seite.'),
        parentId: z.string().optional().describe('Seiten-ID der Elternseite (für eine Unterseite).'),
        templateId: z.string().optional().describe('ID einer Vorlage, aus der der Startinhalt erzeugt wird.'),
      },
    },
    async ({ space, title, parentId, templateId }, extra) =>
      guard(() =>
        apiRequest(tokenFromExtra(extra), '/api/pages', {
          method: 'POST',
          body: { space, title, parentId, templateId },
        }),
      ),
  )

  server.registerTool(
    'edit_page',
    {
      title: 'Seite zum Bearbeiten öffnen',
      description:
        'Öffnet eine bestehende Seite zur Bearbeitung: legt bei Bedarf den Draft-Branch an und liefert den ' +
        'aktuellen Markdown-Inhalt samt `baseSha`. Erster Schritt beim Ändern einer bestehenden Seite. ' +
        'Meldet außerdem, ob die Seite gerade von jemand anderem gesperrt ist (`lock`).',
      inputSchema: { id: z.string().min(1).describe('Seiten-ID.') },
    },
    async ({ id }, extra) =>
      guard(async () => {
        const draft = await apiRequest<DraftState>(
          tokenFromExtra(extra),
          `/api/pages/${encodeURIComponent(id)}/draft`,
          { method: 'POST' },
        )
        // Eine fremde Sperre ist kein Fehler (die API lässt das Schreiben zu),
        // aber der Agent soll es wissen, bevor er jemandem dazwischenschreibt.
        const warning =
          draft.lock && !draft.lock.mine
            ? `\n\nHINWEIS: Diese Seite wird gerade von "${draft.lock.user}" bearbeitet (zuletzt aktiv ${draft.lock.heartbeatAt}). Änderungen könnten sich überschneiden.`
            : ''
        return `${JSON.stringify(draft, null, 2)}${warning}`
      }),
  )

  server.registerTool(
    'update_page_draft',
    {
      title: 'Draft-Inhalt speichern',
      description:
        'Schreibt den vollständigen neuen Markdown-Inhalt in den Draft der Seite (ersetzt den bisherigen Inhalt — ' +
        'also immer den GESAMTEN Text senden, keine Teilstücke). Gibt den neuen `newSha` zurück. ' +
        '`baseSha` sollte aus der letzten Antwort von create_page/edit_page/update_page_draft stammen; ' +
        'wird er weggelassen, ermittelt der Server den aktuellen Stand selbst. ' +
        'Bei einem Konflikt (jemand anderes hat den Draft geändert) kommt eine Fehlermeldung mit dem ' +
        'aktuellen Stand zurück — darauf neu aufsetzen statt zu überschreiben.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID.'),
        content: z.string().describe('Vollständiger neuer Markdown-Inhalt inklusive Frontmatter.'),
        baseSha: z
          .string()
          .optional()
          .describe('SHA des Standes, auf dem die Änderung aufsetzt. Ohne Angabe wird der aktuelle Stand geholt.'),
        message: z.string().optional().describe('Commit-Nachricht.'),
      },
    },
    async ({ id, content, baseSha, message }, extra) =>
      guard(async () => {
        const token = tokenFromExtra(extra)
        // Ohne `baseSha` den aktuellen Stand ermitteln. Das ersetzt NICHT die
        // Konfliktprüfung: Zwischen diesem Aufruf und dem PUT kann sich der
        // Draft weiter bewegen — dann greift weiterhin der 409 der API.
        const sha =
          baseSha ??
          (
            await apiRequest<DraftState>(token, `/api/pages/${encodeURIComponent(id)}/draft`, {
              method: 'POST',
            })
          ).baseSha
        return apiRequest(token, `/api/pages/${encodeURIComponent(id)}/draft`, {
          method: 'PUT',
          body: { content, baseSha: sha, message },
        })
      }),
  )

  server.registerTool(
    'discard_page_draft',
    {
      title: 'Draft verwerfen',
      description:
        'Verwirft den Draft einer Seite: Draft-Branch, Draft-Eintrag und Sperre werden entfernt. ' +
        'Bei einer neu angelegten, nie veröffentlichten Seite verschwindet die Seite damit vollständig. ' +
        'Nicht umkehrbar.',
      inputSchema: { id: z.string().min(1).describe('Seiten-ID.') },
    },
    async ({ id }, extra) =>
      guard(async () => {
        await apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/draft`, {
          method: 'DELETE',
        })
        return { status: 'verworfen', id }
      }),
  )

  server.registerTool(
    'request_review',
    {
      title: 'Review eröffnen',
      description:
        'Eröffnet die Review für den Draft (legt den Pull-Request an) und liefert Nummer, URL und Status. ' +
        'Idempotent: Ist bereits eine Review offen, wird deren Stand zurückgegeben. ' +
        'Der übliche Endpunkt für einen Agenten — die Veröffentlichung (release_page) bleibt danach ' +
        'bewusst einem Menschen überlassen, sofern nicht ausdrücklich anders gewünscht.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID.'),
        reviewers: z.array(z.string()).optional().describe('Benutzernamen der gewünschten Reviewer.'),
      },
    },
    async ({ id, reviewers }, extra) =>
      guard(() =>
        apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/review`, {
          method: 'POST',
          body: { reviewers },
        }),
      ),
  )

  server.registerTool(
    'release_page',
    {
      title: 'Seite veröffentlichen',
      description:
        'Gibt die Seite frei: genehmigt die Review, führt sie zusammen und stößt die Neuindexierung an. ' +
        'Danach ist die Änderung für alle sichtbar. Das ist der Schritt, der eine Änderung wirksam macht — ' +
        'vorher rückfragen, statt ungefragt zu veröffentlichen. ' +
        'In Spaces mit Versionierung erhöht die Freigabe zusätzlich die Version; bump und note bestimmen Sprunggröße und Changelog-Eintrag.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID.'),
        bump: z
          .enum(['patch', 'minor', 'major'])
          .optional()
          .describe(
            'Sprunggröße der Version: patch = Korrektur, minor = Ergänzung, major = grundlegende Änderung. '
              + 'Ohne Angabe patch. Gilt nur in Spaces mit aktivierter Versionierung.',
          ),
        note: z
          .string()
          .optional()
          .describe('Änderungsnotiz für den Changelog der Seite — kurz und für spätere Leser verständlich.'),
        comment: z.string().optional().describe('Kommentar zur Freigabe (erscheint am Pull Request).'),
        archive: z
          .boolean()
          .optional()
          .describe(
            'Als Release festschreiben: eine unveränderliche Kopie dieser Fassung samt Anhängen bleibt dauerhaft lesbar. '
              + 'Nur in Spaces mit Versionierung; nur auf ausdrücklichen Wunsch setzen.',
          ),
      },
    },
    async ({ id, bump, note, comment, archive }, extra) =>
      guard(() =>
        apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/release`, {
          method: 'POST',
          body: { bump, note, comment, archive },
        }),
      ),
  )

  server.registerTool(
    'request_changes',
    {
      title: 'Änderungen anfordern',
      description:
        'Fordert in einer offenen Review Änderungen an (Gegenstück zu release_page) — mit begründendem Kommentar. ' +
        'Nützlich, wenn der Agent als Prüfer auf einen fremden Entwurf schaut.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID.'),
        comment: z.string().min(1).describe('Begründung, was geändert werden soll.'),
      },
    },
    async ({ id, comment }, extra) =>
      guard(async () => {
        await apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/review/request-changes`, {
          method: 'POST',
          body: { comment },
        })
        return { status: 'Änderungen angefordert', id }
      }),
  )
}
