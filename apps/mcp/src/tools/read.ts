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
import { apiRequest, F451Error, type BinaryResponse } from '../client.js'

const EXPORT_FORMATS = ['docx', 'pptx', 'xlsx', 'pdf'] as const

/** Größte Datei, die `export_page` als eingebettete Ressource zurückgibt. */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024

/** Dateiname aus `Content-Disposition` (`filename*` UTF-8 vor `filename`), ohne Verzeichnisanteil. */
export function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null
  let name: string | null = null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim())
    } catch {
      name = null
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header)
    if (plain) name = plain[1]!.replace(/\\(.)/g, '$1').trim()
  }
  const base = name?.split(/[\\/]/).pop()
  return base ? base : null
}

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
        'Optional auf Space, Tag, Relation (`ref`) oder Pfad-Präfix eingegrenzt. ' +
        'Seiten über der Klassifizierungsgrenze des Tokens erscheinen nicht in den Treffern.',
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
        'das liefert die Markdown-Quelle. `restricted: true` heißt: Seite ist höher klassifiziert, als dieses Token ' +
        'lesen darf — nur Titel und Klassifizierung kommen zurück; der Nutzer braucht ein Token mit höherer Grenze.',
      inputSchema: {
        id: z.string().min(1).describe('Seiten-ID, z.B. "p-8wm3oojxko".'),
        version: z
          .string()
          .optional()
          .describe('Releases sind festgeschriebene Fassungen; `version` (z.B. "1.2.0") liest eine davon.'),
      },
    },
    async ({ id, version }, extra) =>
      guard(() =>
        apiRequest(
          tokenFromExtra(extra),
          version
            ? `/api/pages/${encodeURIComponent(id)}/releases/${encodeURIComponent(version)}`
            : `/api/pages/${encodeURIComponent(id)}`,
        ),
      ),
  )

  server.registerTool(
    'get_page_source',
    {
      title: 'Markdown-Quelle einer Seite',
      description:
        'Liefert das rohe Markdown einer Seite (inkl. Frontmatter), frisch aus dem Git-Provider. ' +
        'Das ist die Grundlage für Änderungen: erst hier lesen, dann bearbeiten. ' +
        'Antwortet 403 `token_classification_limit`, wenn die Seite über der Klassifizierungsgrenze des Tokens liegt.',
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
    'export_page',
    {
      title: 'Seite als Office-Datei exportieren',
      description:
        'Exportiert die veröffentlichte Fassung einer Seite (optional samt Unterseiten) als Word (docx), PowerPoint (pptx), ' +
        'Excel (xlsx) oder PDF und liefert die Datei als eingebettete Ressource (Base64, bis 20 MB). ' +
        'Entwürfe fließen nie ein. xlsx enthält nur Tabellen (keine Tabelle → Fehler). ' +
        'Bei sehr vielen Seiten oder langer Laufzeit antwortet die API mit einem Fehler; dann muss der Nutzer den ' +
        'Export im Import-/Export-Bereich von f451 im Browser starten. Ohne eingerichteten Convert-Dienst nicht verfügbar.',
      inputSchema: {
        page_id: z.string().min(1).describe('Seiten-ID der Startseite.'),
        format: z.enum(EXPORT_FORMATS).describe('Zielformat: docx, pptx, xlsx oder pdf.'),
        subpages: z.boolean().optional().describe('Unterseiten mitexportieren (Standard: nein).'),
      },
    },
    async ({ page_id, format, subpages }, extra) => {
      try {
        const file = await apiRequest<BinaryResponse>(tokenFromExtra(extra), `/api/pages/${encodeURIComponent(page_id)}/export`, {
          query: { format, subpages: subpages ? '1' : '0' },
          accept: 'binary',
        })
        if (file.data.byteLength > MAX_EXPORT_BYTES) {
          throw new Error(
            `Die Datei ist größer als ${MAX_EXPORT_BYTES / (1024 * 1024)} MB und kann nicht übertragen werden. ` +
              'Bitte den Export im Import-/Export-Bereich von f451 im Browser starten.',
          )
        }
        const name = fileNameFromDisposition(file.disposition) ?? `export.${format}`
        return {
          content: [
            { type: 'text' as const, text: `${name} (${file.data.byteLength} Bytes)` },
            {
              type: 'resource' as const,
              resource: {
                uri: `f451-export:///${encodeURIComponent(name)}`,
                mimeType: file.contentType,
                blob: Buffer.from(file.data).toString('base64'),
              },
            },
          ],
        }
      } catch (error) {
        return fail(error)
      }
    },
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
