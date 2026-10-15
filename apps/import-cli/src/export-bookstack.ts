import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BookStackClient, F451Api, exportToBookStack, renderExportReport } from '@f451/import'
import { UsageError, type ParsedArgs } from './args.js'

export async function runBookStackExport(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WriteStream,
): Promise<number> {
  const need = (k: string) => {
    const v = env[k]
    if (!v) throw new UsageError(`${k} is not set`)
    return v
  }
  const f451Url = need('F451_URL')
  const bookstackUrl = need('BOOKSTACK_URL')
  const f451 = new F451Api(f451Url, need('F451_TOKEN'))
  const bs = new BookStackClient(bookstackUrl, need('BOOKSTACK_TOKEN_ID'), need('BOOKSTACK_TOKEN_SECRET'))

  const report = await exportToBookStack(
    f451,
    bs,
    {
      space: args.space,
      startPageId: args.page,
      bookId: args.book !== undefined ? Number(args.book) : undefined,
      dryRun: args.dryRun,
      f451Url,
      bookstackUrl,
    },
    (e) => {
      if (e.kind === 'start') out.write(`${e.pages} pages\n`)
      if (e.kind === 'page') {
        out.write(`${e.status.padEnd(8)} ${e.name} (${e.pageId})${e.bsId ? ` → ${e.bsId}` : ''}${e.reason ? ` (${e.reason})` : ''}\n`)
      }
    },
  )

  const outDir = args.out ?? '.'
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'export-report.md'), renderExportReport(report))
  if (args.dryRun) {
    for (const p of report.dryRunPages ?? []) {
      // Page ids are f451 ids; keep the file name safe regardless.
      await writeFile(join(outDir, `${p.pageId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.html`), p.html)
    }
  }
  out.write(`report: ${join(outDir, 'export-report.md')}\n`)
  out.write(
    `created ${report.created.length}, updated ${report.updated.length}, failed ${report.failed.length}, stale ${report.stale.length}\n`,
  )
  return report.failed.length ? 1 : 0
}
