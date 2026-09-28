/**
 * Lese-Tools (Phase A) — bilden die rechtegeprüften GET-Routen der f451-API
 * auf MCP-Tools ab.
 *
 * Alle Tools laufen im Namen des aufrufenden Nutzers: Der pro Request
 * durchgereichte Token entscheidet, welche Spaces und Seiten sichtbar sind.
 * Es gibt hier bewusst KEINE eigene Rechtelogik — was der Nutzer im Browser
 * nicht sehen darf, liefert die API auch dem Agenten nicht.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { tokenFromExtra } from '../auth.js'
import { apiRequest, F451Error } from '../client.js'

/** MCP-Rückgabeform für Erfolg: JSON lesbar eingerückt als Text-Content. */
function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * MCP-Rückgabeform für Fehler.
 *
 * Bewusst `isError` statt eines geworfenen Fehlers: Der Agent soll den
 * Klartext lesen und daraus handeln können (Token erneuern, Konto verbinden,
 * Konflikt auflösen) statt nur einen Protokollfehler zu sehen. Bei 409 wird
 * der Rohkörper mitgegeben, weil er `currentSha`/`currentContent` trägt.
 */
function fail(error: unknown) {
  if (error instanceof F451Error) {
    const detail = error.status === 409 && error.data ? `\n\n${JSON.stringify(error.data, null, 2)}` : ''
    return { content: [{ type: 'text' as const, text: `${error.message}${detail}` }], isError: true }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/** Führt einen Tool-Rumpf aus und übersetzt Fehler in MCP-Fehlerantworten. */
export async function guard(run: () => Promise<unknown>) {
  try {
    return ok(await run())
  } catch (error) {
    return fail(error)
  }
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'search_wiki',
    {
      title: 'Wiki durchsuchen',
      description:
        'Durchsucht das f451-Wiki (Volltext) und liefert Treffer mit Seiten-ID, Titel, Space, Pfad und Textausschnitt. ' +
        'Die zurückgegebene `id` ist der Schlüssel für alle weiteren Tools (read_page, get_page_source, …). ' +
        'Optional auf Space, Tag, Relation (`ref`) oder Pfad-Präfix eingegrenzt.',
      inputSchema: {
        q: z.string().min(1).describe('Suchbegriff (Volltext).'),
        space: z.string().optional().describe('Nur in diesem Space suchen, z.B. "handbuch".'),
        tag: z.string().optional().describe('Nur Seiten mit diesem Tag.'),
        ref: z.string().optional().describe('Nur Seiten, die auf diese Seiten-ID verweisen.'),
        prefix: z.string().optional().describe('Nur Seiten unterhalb dieses Pfad-Präfixes.'),
      },
    },
    async ({ q, space, tag, ref, prefix }, extra) =>
      guard(() =>
        apiRequest(tokenFromExtra(extra), '/api/search', { query: { q, space, tag, ref, prefix } }),
      ),
  )

  server.registerTool(
    'list_spaces',
    {
      title: 'Spaces auflisten',
      description:
        'Listet alle Spaces (Wiki-Bereiche), auf die der Nutzer Zugriff hat, mit ID, Name und Standardsprache. ' +
        'Guter erster Aufruf, um die Struktur des Wikis zu erfassen.',
      inputSchema: {},
    },
    async (_args, extra) => guard(() => apiRequest(tokenFromExtra(extra), '/api/spaces')),
  )

  server.registerTool(
    'get_tree',
    {
      title: 'Seitenbaum eines Space',
      description:
        'Liefert die hierarchische Seitenstruktur eines Space (verschachtelt, mit Seiten-ID, Titel, Pfad und Archiv-Status). ' +
        'Nützlich, um sich zu orientieren, bevor einzelne Seiten gelesen werden.',
      inputSchema: { space: z.string().min(1).describe('Space-ID, z.B. "handbuch".') },
    },
    async ({ space }, extra) =>
      guard(() => apiRequest(tokenFromExtra(extra), `/api/spaces/${encodeURIComponent(space)}/tree`)),
  )

  server.registerTool(
    'read_page',
    {
      title: 'Seite lesen (gerendert)',
      description:
        'Liest eine Seite mit gerendertem HTML und allen Metadaten: Titel, Tags, Relationen, Überschriften, ' +
        'Bearbeitungsstand (workflow) und defekte Links. Zum Bearbeiten stattdessen get_page_source verwenden — ' +
        'das liefert die Markdown-Quelle.',
      inputSchema: { id: z.string().min(1).describe('Seiten-ID, z.B. "p-8wm3oojxko".') },
    },
    async ({ id }, extra) =>
      guard(() => apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'get_page_source',
    {
      title: 'Markdown-Quelle einer Seite',
      description:
        'Liefert das rohe Markdown einer Seite (inkl. Frontmatter), frisch aus dem Git-Provider. ' +
        'Das ist die Grundlage für Änderungen: erst hier lesen, dann bearbeiten.',
      inputSchema: { id: z.string().min(1).describe('Seiten-ID.') },
    },
    async ({ id }, extra) =>
      guard(() =>
        apiRequest(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(id)}/raw`, { accept: 'text' }),
      ),
  )

  server.registerTool(
    'get_graph',
    {
      title: 'Wissensgraph',
      description:
        'Liefert den Verknüpfungsgraphen als Knoten und Kanten (Typen: link, relation, hierarchy, tag). ' +
        'Mit `id` den Nachbarschaftsgraphen einer Seite (Reichweite über `depth`), mit `space` den ganzen Space. ' +
        'Genau eines von beiden angeben.',
      inputSchema: {
        id: z.string().optional().describe('Seiten-ID für den Nachbarschaftsgraphen.'),
        space: z.string().optional().describe('Space-ID für den vollständigen Space-Graphen.'),
        depth: z.number().int().min(1).max(3).optional().describe('Nur mit `id`: Reichweite in Sprüngen (1–3).'),
        types: z
          .string()
          .optional()
          .describe('Kommaliste der Kantentypen zum Filtern, z.B. "link,relation".'),
      },
    },
    async ({ id, space, depth, types }, extra) =>
      guard(() => {
        if ((id && space) || (!id && !space)) {
          throw new Error('Bitte genau eines angeben: `id` (Seiten-Nachbarschaft) ODER `space` (ganzer Space).')
        }
        const token = tokenFromExtra(extra)
        return id
          ? apiRequest(token, `/api/pages/${encodeURIComponent(id)}/graph`, { query: { depth, types } })
          : apiRequest(token, `/api/spaces/${encodeURIComponent(space!)}/graph`, { query: { types } })
      }),
  )

  server.registerTool(
    'list_broken_links',
    {
      title: 'Defekte Verweise eines Space',
      description:
        'Listet alle Seiten eines Space mit ins Leere laufenden Verweisen (Wikilinks und Relationen), ' +
        'jeweils mit dem rohen Linkziel. Nützlich für Pflege- und Aufräumaufträge.',
      inputSchema: { space: z.string().min(1).describe('Space-ID.') },
    },
    async ({ space }, extra) =>
      guard(() =>
        apiRequest(tokenFromExtra(extra), `/api/spaces/${encodeURIComponent(space)}/broken-links`),
      ),
  )
}
