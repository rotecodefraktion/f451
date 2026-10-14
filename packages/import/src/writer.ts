import { F451ApiError, type F451Api, type TreeNode } from './api.js'
import { buildPageContent, importUnchanged, mergeIntoExisting, readSource } from './frontmatter.js'
import { rewriteLinks } from './links.js'
import type { ImportEvent, ImportMedia, ImportNode, ImportOptions, ImportTarget, ImportTree } from './model.js'
import { flattenTree, type FlatEntry } from './order.js'
import { emptyReport, type ImportReport } from './report.js'
import { diagramXml } from './svg-diagram.js'

/** Upload limit per file, matching the `F451_MAX_UPLOAD_MB` default of the API. */
export const MAX_UPLOAD = 10 * 1024 * 1024

/** The part of the f451 API client the writer uses. */
export type WriterApi = Pick<
  F451Api,
  | 'tree' | 'raw' | 'createPage' | 'getDraft' | 'openDraft' | 'putDraft' | 'uploadMedia' | 'requestReview' | 'release' | 'reorder'
  | 'media' | 'discardDraft'
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

/** The API sanitises an uploaded SVG, so a stored diagram never equals the
 *  rendered bytes; two diagrams are the same when their embedded draw.io XML
 *  is. Everything else compares byte for byte. */
function sameMedia(m: ImportMedia, existing: Uint8Array): boolean {
  if (m.kind !== 'drawio') return Buffer.from(m.bytes).equals(Buffer.from(existing))
  const a = diagramXml(m.bytes)
  return a !== null && a === diagramXml(existing)
}

/** Statuses with which the API refuses a single upload by its rules (size,
 *  file type, SVG sanitising). The file is skipped, the page is still written. */
const REFUSED_UPLOAD = new Set([413, 415, 422])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `_media/` file names referenced in `content` that may hold `name`: the
 *  name itself or the name with the API's collision suffix `-N` before the
 *  extension (`.drawio.svg`/`.excalidraw.svg` count as one). Exact name first. */
function storedCandidates(content: string, name: string): string[] {
  const compound = /\.(drawio|excalidraw)\.svg$/.exec(name)
  const dot = compound ? compound.index : name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const suffixed = new RegExp(`^${escapeRegExp(stem)}-\\d+${escapeRegExp(ext)}$`)
  const found = new Set<string>()
  for (const match of content.matchAll(/_media\/([A-Za-z0-9._-]+)/g)) {
    const file = match[1]!
    if (file === name || suffixed.test(file)) found.add(file)
  }
  return [...found].sort((a, b) => (a === name ? -1 : b === name ? 1 : 0))
}

/** The file name under `_media/` the existing page already stores `m` as,
 *  or null when no referenced candidate has the same content. */
async function findStored(api: WriterApi, pageId: string, content: string, m: ImportMedia): Promise<string | null> {
  for (const file of storedCandidates(content, m.name)) {
    const bytes = await api.media(pageId, file, 'draft')
    if (bytes && sameMedia(m, bytes)) return file
  }
  return null
}

/** Replaces every reference in one pass, so a new path that equals another
 *  medium's original ref (`foo.png` → `foo-1.png`) is not rewritten again. */
function replaceRefs(markdown: string, refs: Map<string, string>): string {
  const keys = [...refs.keys()].filter((k) => refs.get(k) !== k).sort((a, b) => b.length - a.length)
  if (keys.length === 0) return markdown
  return markdown.replace(new RegExp(keys.map(escapeRegExp).join('|'), 'g'), (k) => refs.get(k)!)
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
  // Checked between pages only: a page in progress is always finished.
  const aborted = () => opts.signal?.aborted === true

  // 0. existing pages by source id (GET raw reads main). The lookup belongs to
  //    the creating phase: it emits no page events either.
  onEvent({ kind: 'phase', phase: 'creating' })
  // Cancelled before anything happened: no reads against f451 either.
  if (aborted()) {
    for (const { node } of entries) {
      if (failedIds.has(node.sourceRef.id)) continue
      report.cancelled.push({ sourceId: node.sourceRef.id, title: node.title, reason: 'cancelled' })
      onEvent({ kind: 'page', sourceId: node.sourceRef.id, title: node.title, status: 'cancelled', reason: 'cancelled' })
    }
    onEvent({ kind: 'done' })
    return report
  }
  const existing = await findExisting(api, target.space, entries)

  // 1. pass one: create pages, parents before children
  const ids = new Map<string, string>() // sourceId → f451 id
  const created = new Map<string, { baseSha: string }>()
  for (const { node, parent } of entries) {
    if (aborted()) break
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

  /** Reports every remaining page as cancelled. A page created in pass one
   *  but never filled would leave an empty draft behind; its draft is
   *  discarded so a later run starts clean. */
  const cancelRest = async (rest: FlatEntry[]): Promise<void> => {
    for (const { node } of rest) {
      const sid = node.sourceRef.id
      if (failedIds.has(sid)) continue
      const pageId = ids.get(sid)
      let reason = 'cancelled'
      if (pageId && created.has(sid)) {
        try {
          await api.discardDraft(pageId)
          reason = 'cancelled before content, draft discarded'
        } catch (e) {
          reason = `cancelled before content, discarding the draft failed: ${describe(e)}`
        }
      }
      const ref = pageId && !pageId.startsWith('dry-') ? { pageId } : {}
      report.cancelled.push({ sourceId: sid, title: node.title, ...ref, reason })
      onEvent({ kind: 'page', sourceId: sid, title: node.title, status: 'cancelled', ...ref, reason })
    }
  }

  // 2. pass two: content, media, review
  onEvent({ kind: 'phase', phase: 'writing' })
  for (const [index, { node }] of entries.entries()) {
    if (aborted()) {
      await cancelRest(entries.slice(index))
      break
    }
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
    // True while this run holds a draft (created in pass one or opened here)
    // that has no content written yet; a failure then discards it, so a
    // later run starts clean.
    let discardOnFail = false
    try {
      let baseSha: string
      let existingContent = ''
      if (isNew) {
        baseSha = created.get(sid)!.baseSha
        discardOnFail = true
      } else {
        if (await api.getDraft(pageId)) {
          skip(node, pageId, 'draft already open')
          continue
        }
        const d = await api.openDraft(pageId)
        discardOnFail = true
        baseSha = d.baseSha
        existingContent = d.content
      }
      const refs = new Map<string, string>() // media ref → new destination
      let uploaded = 0
      for (const m of node.media) {
        if (m.bytes.byteLength > MAX_UPLOAD) {
          report.mediaSkipped.push({ sourceId: sid, name: m.name, reason: 'too large' })
          onEvent({ kind: 'media', sourceId: sid, name: m.name, status: 'skipped', reason: 'too large' })
          if (m.sourceUrl) refs.set(m.ref, m.sourceUrl)
          continue
        }
        // On an update the draft starts from the published page; an
        // unchanged file is reused under the name it is stored as (possibly
        // with a collision suffix) instead of uploaded again.
        if (!isNew) {
          const stored = await findStored(api, pageId, existingContent, m)
          if (stored) {
            refs.set(m.ref, `_media/${stored}`)
            continue
          }
        }
        try {
          const u = await api.uploadMedia(pageId, m.name, m.bytes, m.mime)
          uploaded++
          refs.set(m.ref, u.path)
          onEvent({ kind: 'media', sourceId: sid, name: m.name, status: 'uploaded' })
        } catch (e) {
          if (!(e instanceof F451ApiError) || !REFUSED_UPLOAD.has(e.status)) throw e
          const reason = describe(e)
          report.mediaSkipped.push({ sourceId: sid, name: m.name, reason })
          onEvent({ kind: 'media', sourceId: sid, name: m.name, status: 'skipped', reason })
          if (m.sourceUrl) refs.set(m.ref, m.sourceUrl)
        }
      }
      const markdown = rewriteLinks(replaceRefs(node.markdown, refs), ids)
      const content = isNew
        ? buildPageContent({ id: pageId, title: node.title, tags: node.tags, source: node.sourceRef, body: markdown })
        : mergeIntoExisting(existingContent, { tags: node.tags, body: markdown })
      if (!isNew && uploaded === 0 && importUnchanged(existingContent, { tags: node.tags, body: markdown })) {
        discardOnFail = false
        await api.discardDraft(pageId)
        skip(node, pageId, 'unchanged')
        continue
      }
      // Media uploads commit to the draft branch, but the page file itself is
      // unchanged, so the blob sha from createPage/openDraft is still valid.
      await api.putDraft(pageId, content, baseSha, `Import from ${node.sourceRef.type}`)
      discardOnFail = false
      await api.requestReview(pageId)
      if (opts.release) await api.release(pageId, { bump: 'major', note: `Imported from ${node.sourceRef.type}` })
      ;(isNew ? report.created : report.updated).push({ sourceId: sid, title: node.title, pageId })
      onEvent({ kind: 'page', sourceId: sid, title: node.title, status: isNew ? 'created' : 'updated', pageId })
    } catch (e) {
      let reason = describe(e)
      if (discardOnFail) {
        try {
          await api.discardDraft(pageId)
          reason += ', draft discarded'
        } catch (d) {
          reason += `, discarding the draft failed: ${describe(d)}`
        }
      }
      fail(node, reason, pageId)
    }
  }

  // 3. order (the API commits it to main, so only after release)
  // After a cancel the order of a partial tree would be wrong; leave it.
  // Pages whose review is still open are not on main, so the API refuses
  // them as children; leave them out like failed ones.
  if (opts.release && !opts.dryRun && !aborted()) {
    await applyOrder(tree, ids, new Set([...failedIds, ...openReview]), target, api, report)
  }
  onEvent({ kind: 'done' })
  return report
}
