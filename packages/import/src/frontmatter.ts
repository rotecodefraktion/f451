import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { SourceRef } from './model.js'

const FM = /^---\n([\s\S]*?)\n---\n?/

function split(content: string): { yaml: string; body: string } {
  const m = FM.exec(content)
  if (!m) return { yaml: '', body: content }
  return { yaml: m[1], body: content.slice(m[0].length).replace(/^\n/, '') }
}

function join(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data, { lineWidth: 0 }).replace(/\n$/, '')
  return `---\n${yaml}\n---\n\n${body}`
}

export function buildPageContent(p: { id: string; title: string; tags: string[]; source: SourceRef; body: string }): string {
  const data: Record<string, unknown> = { id: p.id, title: p.title }
  if (p.tags.length) data.tags = p.tags
  data.source = {
    type: p.source.type,
    id: p.source.id,
    ...(p.source.url ? { url: p.source.url } : {}),
    ...(p.source.origin ? { origin: p.source.origin } : {}),
  }
  return join(data, p.body)
}

export function readSource(content: string): SourceRef | null {
  const { yaml } = split(content)
  if (!yaml) return null
  const data = parseYaml(yaml) as Record<string, unknown> | null
  const s = data?.source
  if (!s || typeof s !== 'object') return null
  const { type, id, url, origin } = s as Record<string, unknown>
  if (typeof type !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return null
  return {
    type,
    id: String(id),
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof origin === 'string' && origin ? { origin } : {}),
  }
}

/** The import a source belongs to: its `origin`, else the origin of its URL
 *  (BookStack: `https://host`). Undefined when neither is known. */
export function originOf(ref: SourceRef): string | undefined {
  if (ref.origin) return ref.origin
  if (!ref.url) return undefined
  try {
    const o = new URL(ref.url).origin
    return o === 'null' ? undefined : o
  } catch {
    return undefined
  }
}

/** Keeps everything f451 wrote into the frontmatter (id, classification,
 *  metadata, version …); only `title`, `tags` and the body come from the
 *  source, so a renamed source renames the page. With `origin`, the source
 *  block gains `origin` (type and id stay). */
export function mergeIntoExisting(
  existing: string,
  p: { title: string; tags: string[]; body: string; origin?: string },
): string {
  const { yaml } = split(existing)
  const data = (yaml ? (parseYaml(yaml) as Record<string, unknown>) : {}) ?? {}
  data.title = p.title
  if (p.tags.length) data.tags = p.tags
  else delete data.tags
  if (p.origin && data.source && typeof data.source === 'object' && !Array.isArray(data.source)) {
    data.source = { ...(data.source as Record<string, unknown>), origin: p.origin }
  }
  return join(data, p.body)
}

/** True if `existing` already has exactly this title, body and these tags,
 *  i.e. an update would change nothing the import owns. With `origin`, a
 *  source block that lacks an origin counts as a change: `mergeIntoExisting`
 *  would add it, and without it a later rename is not matched by origin. */
export function importUnchanged(
  existing: string,
  p: { title: string; tags: string[]; body: string; origin?: string },
): boolean {
  const { yaml, body } = split(existing)
  const data = (yaml ? (parseYaml(yaml) as Record<string, unknown> | null) : null) ?? {}
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : []
  const title = data.title === undefined || data.title === null ? '' : String(data.title)
  const source = data.source
  const missingOrigin =
    !!p.origin &&
    !!source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    !(source as Record<string, unknown>).origin
  return (
    !missingOrigin &&
    title === p.title &&
    body === p.body &&
    tags.length === p.tags.length &&
    tags.every((t, i) => t === p.tags[i])
  )
}
