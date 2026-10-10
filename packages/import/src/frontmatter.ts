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
  data.source = { type: p.source.type, id: p.source.id, ...(p.source.url ? { url: p.source.url } : {}) }
  return join(data, p.body)
}

export function readSource(content: string): SourceRef | null {
  const { yaml } = split(content)
  if (!yaml) return null
  const data = parseYaml(yaml) as Record<string, unknown> | null
  const s = data?.source
  if (!s || typeof s !== 'object') return null
  const { type, id, url } = s as Record<string, unknown>
  if (typeof type !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return null
  return { type, id: String(id), ...(typeof url === 'string' ? { url } : {}) }
}

/** Keeps everything f451 wrote into the frontmatter (id, classification,
 *  metadata, version …); only `tags` and the body come from the source. */
export function mergeIntoExisting(existing: string, p: { tags: string[]; body: string }): string {
  const { yaml } = split(existing)
  const data = (yaml ? (parseYaml(yaml) as Record<string, unknown>) : {}) ?? {}
  if (p.tags.length) data.tags = p.tags
  else delete data.tags
  return join(data, p.body)
}

/** True if `existing` already has exactly this body and these tags, i.e. an
 *  update would change nothing the import owns. */
export function importUnchanged(existing: string, p: { tags: string[]; body: string }): boolean {
  const { yaml, body } = split(existing)
  const data = (yaml ? (parseYaml(yaml) as Record<string, unknown> | null) : null) ?? {}
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : []
  return body === p.body && tags.length === p.tags.length && tags.every((t, i) => t === p.tags[i])
}
