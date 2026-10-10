import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BookStackClient,
  F451Api,
  detectDrawioRenderer,
  flattenTree,
  importTree,
  loadBookStackTree,
  renderReport,
} from '@f451/import'
import { UsageError, type ParsedArgs } from './args.js'

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** `<sourceId>-<slug>.md`; the source id keeps equal titles apart. */
function dryRunFileName(sourceId: string, title: string): string {
  const safeId = sourceId.replace(/[^a-zA-Z0-9]+/g, '-')
  const s = slug(title)
  return s ? `${safeId}-${s}.md` : `${safeId}.md`
}

export async function runBookStackImport(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WriteStream,
): Promise<number> {
  const need = (k: string) => {
    const v = env[k]
    if (!v) throw new UsageError(`${k} is not set`)
    return v
  }
  const f451 = new F451Api(need('F451_URL'), need('F451_TOKEN'))
  const bs = new BookStackClient(need('BOOKSTACK_URL'), need('BOOKSTACK_TOKEN_ID'), need('BOOKSTACK_TOKEN_SECRET'))
  const drawio = await detectDrawioRenderer()
  if (!drawio) out.write('no docker/podman found: drawings stay PNG\n')
  const tree = await loadBookStackTree(
    bs,
    { book: args.book, shelf: args.shelf, page: args.page },
    { baseUrl: need('BOOKSTACK_URL'), drawio, maxBytes: 10 * 1024 * 1024 },
  )
  const report = await importTree(
    tree,
    { space: args.space, parentId: args.parent },
    f451,
    { update: args.update, release: args.release, dryRun: args.dryRun },
    (e) => {
      if (e.kind === 'start') out.write(`${e.pages} pages\n`)
      if (e.kind === 'page') {
        out.write(
          `${e.status.padEnd(7)} ${e.title}${e.pageId ? ` → ${e.pageId}` : ''}${e.reason ? ` (${e.reason})` : ''}\n`,
        )
      }
    },
  )
  const md = renderReport(report)
  const outDir = args.out ?? '.'
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'import-report.md'), md)
  if (args.dryRun) {
    for (const { node } of flattenTree(tree)) {
      await writeFile(join(outDir, dryRunFileName(node.sourceRef.id, node.title)), node.markdown)
    }
  }
  out.write(`report: ${join(outDir, 'import-report.md')}\n`)
  out.write(
    `created ${report.created.length}, updated ${report.updated.length}, skipped ${report.skipped.length}, failed ${report.failed.length}\n`,
  )
  return report.failed.length ? 1 : 0
}
