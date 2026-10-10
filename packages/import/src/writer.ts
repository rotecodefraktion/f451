import { F451ApiError, type F451Api, type TreeNode } from './api.js'
import { buildPageContent, mergeIntoExisting, readSource } from './frontmatter.js'
import { rewriteLinks } from './links.js'
import type { ImportEvent, ImportNode, ImportOptions, ImportTarget, ImportTree } from './model.js'
import { flattenTree, type FlatEntry } from './order.js'
import { emptyReport, type ImportReport } from './report.js'

/** Upload limit per file, matching the `F451_MAX_UPLOAD_MB` default of the API. */
export const MAX_UPLOAD = 10 * 1024 * 1024

/** The part of the f451 API client the writer uses. */
export type WriterApi = Pick<
  F451Api,
  'tree' | 'raw' | 'createPage' | 'getDraft' | 'openDraft' | 'putDraft' | 'uploadMedia' | 'requestReview' | 'release' | 'reorder'
>

/** On a 409 from `createPage`, the id of the conflicting page if its draft
 *  carries the same origin as `node`; otherwise null. */
async function sameOriginDraft(api: WriterApi, e: unknown, node: ImportNode): Promise<string | null> {
  if (!(e instanceof F451ApiError) || e.status !== 409) return null
  const pageId = (e.body as { pageId?: unknown } | null)?.pageId
  if (typeof pageId !== 'string') return null
  try {
    const draft = await api.getDraft(pageId)
    const source = draft ? readSource(draft.content) : null
    return source && source.type === node.sourceRef.type && source.id === node.sourceRef.id ? pageId : null
  } catch {
    return null
  }
}

function describe(e: unknown): string {
  if (e instanceof F451ApiError) {
    const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>
    const detail = body.error ?? body.reason ?? ''
    let out = `${e.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    if (e.status === 409 && typeof body.pageId === 'string') out += `, existing page ${body.pageId}`
    return out
  }
  return e instanceof Error ? e.message : String(e)
}

/** Pages already in the space that came from the same source, keyed by source
 *  id. Only pages whose title matches an entry title are read (one `raw` each);
 *  a failing `raw` counts as "not a match". Also returns all page ids of the
 *  tree, so a stale `knownF451Id` can be ignored. */
async function findExisting(
  api: WriterApi,
  space: string,
  entries: FlatEntry[],
): Promise<{ bySource: Map<string, string>; pageIds: Set<string> }> {
  const bySource = new Map<string, string>()
  const pageIds = new Set<string>()
  const titles = new Set(entries.map((e) => e.node.title))
  const types = new Set(entries.map((e) => e.node.sourceRef.type))
  const candidates: TreeNode[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      pageIds.add(n.id)
      if (titles.has(n.title)) candidates.push(n)
      walk(n.children ?? [])
    }
  }
  walk(await api.tree(space))
  for (const c of candidates) {
    let content: string
    try {
      content = await api.raw(c.id)
    } catch {
      continue
    }
    const source = readSource(content)
    if (source && types.has(source.type) && !bySource.has(source.id)) bySource.set(source.id, c.id)
  }
  return { bySource, pageIds }
}

/** One `reorder` per parent with at least two children whose f451 ids are
 *  known. Pages that failed during this run are left out. */
async function applyOrder(
  tree: ImportTree,
  ids: Map<string, string>,
  failed: Set<string>,
  target: ImportTarget,
  api: WriterApi,
  report: ImportReport,
): Promise<void> {
  const groups: Array<{ parentId: string | null; title: string; children: ImportNode[] }> = []
  const walk = (nodes: ImportNode[], parentId: string | null, title: string) => {
    groups.push({ parentId, title, children: nodes })
    for (const n of nodes) {
      if (n.children.length === 0) continue
      const id = ids.get(n.sourceRef.id)
      if (id) walk(n.children, id, n.title)
    }
  }
  walk(tree.root, target.parentId ?? null, '(root)')

  for (const g of groups) {
    const ordered = [...g.children]
      .sort((x, y) => x.order - y.order)
      .filter((n) => !failed.has(n.sourceRef.id))
      .map((n) => ids.get(n.sourceRef.id))
      .filter((id): id is string => !!id)
    if (ordered.length < 2) continue
    try {
      await api.reorder(target.space, g.parentId, ordered)
    } catch (e) {
      report.failed.push({ sourceId: `order:${g.parentId ?? 'root'}`, title: g.title, reason: describe(e) })
    }
  }
}

export async function importTree(
  tree: ImportTree,
  target: ImportTarget,
  api: WriterApi,
  opts: ImportOptions,
  onEvent: (e: ImportEvent) => void,
): Promise<ImportReport> {
  const report = emptyReport()
  report.droppedHtml = tree.droppedHtml
  report.drawingsAsPng = tree.drawingsAsPng
  report.failed.push(...tree.failed.map((f) => ({ sourceId: f.sourceId, title: f.title, reason: f.reason })))
  report.mediaSkipped.push(...tree.mediaSkipped)

  const entries = flattenTree(tree)
  onEvent({ kind: 'start', pages: entries.length })

  const failedIds = new Set<string>()
  const openReview = new Set<string>()
  const fail = (node: ImportNode, reason: string, pageId?: string) => {
    const sourceId = node.sourceRef.id
    failedIds.add(sourceId)
    report.failed.push({ sourceId, title: node.title, reason, ...(pageId ? { pageId } : {}) })
    onEvent({ kind: 'page', sourceId, title: node.title, status: 'failed', reason, ...(pageId ? { pageId } : {}) })
  }
  const skip = (node: ImportNode, pageId: string, reason: string) => {
    const sourceId = node.sourceRef.id
    report.skipped.push({ sourceId, title: node.title, pageId, reason })
    onEvent({ kind: 'page', sourceId, title: node.title, status: 'skipped', pageId, reason })
  }

  // 0. existing pages by source id (GET raw reads main)
  const existing = await findExisting(api, target.space, entries)

  // 1. pass one: create pages, parents before children
  const ids = new Map<string, string>() // sourceId → f451 id
  const created = new Map<string, { baseSha: string }>()
  for (const { node, parent } of entries) {
    const sid = node.sourceRef.id
    const tagged = node.knownF451Id && existing.pageIds.has(node.knownF451Id) ? node.knownF451Id : undefined
    const known = tagged ?? existing.bySource.get(sid)
    if (known) {
      ids.set(sid, known)
      continue
    }
    const parentId = parent ? ids.get(parent.sourceRef.id) : target.parentId
    if (parent && !parentId) {
      fail(node, 'parent was not created')
      continue
    }
    if (opts.dryRun) {
      ids.set(sid, `dry-${sid}`)
      continue
    }
    try {
      const r = await api.createPage({ space: target.space, title: node.title, ...(parentId ? { parentId } : {}) })
      ids.set(sid, r.id)
      created.set(sid, { baseSha: r.baseSha })
    } catch (e) {
      // The tree and `raw` only see the published version. A page imported
      // earlier whose review is still open shows up here as a path conflict;
      // if its draft carries the same origin it is the same page.
      const existingId = await sameOriginDraft(api, e, node)
      if (existingId) {
        ids.set(sid, existingId)
        openReview.add(sid)
      } else fail(node, describe(e))
    }
  }

  // 2. pass two: content, media, review
  for (const { node } of entries) {
    const sid = node.sourceRef.id
    const pageId = ids.get(sid)
    if (!pageId || failedIds.has(sid)) continue
    const isNew = created.has(sid) || (opts.dryRun && pageId === `dry-${sid}`)
    if (openReview.has(sid)) {
      skip(node, pageId, 'already imported, review still open')
      continue
    }
    if (!isNew && !opts.update) {
      skip(node, pageId, 'already imported')
      continue
    }
    if (opts.dryRun) {
      ;(isNew ? report.created : report.updated).push({ sourceId: sid, title: node.title, pageId })
      onEvent({ kind: 'page', sourceId: sid, title: node.title, status: isNew ? 'created' : 'updated', pageId })
      continue
    }
    try {
      let baseSha: string
      let existingContent = ''
      if (isNew) {
        baseSha = created.get(sid)!.baseSha
      } else {
        if (await api.getDraft(pageId)) {
          skip(node, pageId, 'draft already open')
          continue
        }
        const d = await api.openDraft(pageId)
        baseSha = d.baseSha
        existingContent = d.content
      }
      let markdown = node.markdown
      for (const m of node.media) {
        if (m.bytes.byteLength > MAX_UPLOAD) {
          report.mediaSkipped.push({ sourceId: sid, name: m.name, reason: 'too large' })
          onEvent({ kind: 'media', sourceId: sid, name: m.name, status: 'skipped', reason: 'too large' })
          continue
        }
        const u = await api.uploadMedia(pageId, m.name, m.bytes, m.mime)
        if (u.path !== m.ref) markdown = markdown.split(m.ref).join(u.path)
        onEvent({ kind: 'media', sourceId: sid, name: m.name, status: 'uploaded' })
      }
      markdown = rewriteLinks(markdown, ids)
      const content = isNew
        ? buildPageContent({ id: pageId, title: node.title, tags: node.tags, source: node.sourceRef, body: markdown })
        : mergeIntoExisting(existingContent, { tags: node.tags, body: markdown })
      // Media uploads commit to the draft branch, but the page file itself is
      // unchanged, so the blob sha from createPage/openDraft is still valid.
      await api.putDraft(pageId, content, baseSha, `Import from ${node.sourceRef.type}`)
      await api.requestReview(pageId)
      if (opts.release) await api.release(pageId, { bump: 'major', note: `Imported from ${node.sourceRef.type}` })
      ;(isNew ? report.created : report.updated).push({ sourceId: sid, title: node.title, pageId })
      onEvent({ kind: 'page', sourceId: sid, title: node.title, status: isNew ? 'created' : 'updated', pageId })
    } catch (e) {
      fail(node, describe(e), pageId)
    }
  }

  // 3. order (the API commits it to main, so only after release)
  if (opts.release && !opts.dryRun) await applyOrder(tree, ids, failedIds, target, api, report)
  onEvent({ kind: 'done' })
  return report
}
