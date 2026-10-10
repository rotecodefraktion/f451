import { parseArgs as nodeParseArgs } from 'node:util'

export interface ParsedArgs {
  command: 'import' | 'export'
  source: 'bookstack'
  book?: string
  shelf?: string
  page?: string
  space: string
  parent?: string
  update: boolean
  release: boolean
  dryRun: boolean
  out?: string
}

export const USAGE = `Usage: f451-import bookstack (--book <id|slug> | --shelf <id|slug> | --page <id>) --space <space> [options]

Options:
  --parent <pageId>   import below this page
  --update            update pages that were imported before
  --release           release the pages (and apply the order) instead of leaving reviews open
  --dry-run           write nothing to f451; write the converted Markdown to --out
  --out <dir>         directory for the report (default: .)

Environment: F451_URL, F451_TOKEN, BOOKSTACK_URL, BOOKSTACK_TOKEN_ID, BOOKSTACK_TOKEN_SECRET`

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`)
    this.name = 'UsageError'
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  let parsed
  try {
    parsed = nodeParseArgs({
      // `pnpm … start -- bookstack …` passes the separator through.
      args: argv[0] === '--' ? argv.slice(1) : argv,
      allowPositionals: true,
      strict: true,
      options: {
        book: { type: 'string' },
        shelf: { type: 'string' },
        page: { type: 'string' },
        space: { type: 'string' },
        parent: { type: 'string' },
        out: { type: 'string' },
        update: { type: 'boolean' },
        release: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
  const { values, positionals } = parsed

  const command = positionals[0]
  if (command !== 'bookstack') {
    throw new UsageError(command ? `unknown command: ${command}` : 'missing command')
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`)

  const selectors = [values.book, values.shelf, values.page].filter((v) => v !== undefined)
  if (selectors.length !== 1) throw new UsageError('exactly one of --book, --shelf, --page is required')
  if (!values.space) throw new UsageError('--space is required')

  const result: ParsedArgs = {
    command: 'import',
    source: 'bookstack',
    space: values.space,
    update: values.update ?? false,
    release: values.release ?? false,
    dryRun: values['dry-run'] ?? false,
  }
  if (values.book !== undefined) result.book = values.book
  if (values.shelf !== undefined) result.shelf = values.shelf
  if (values.page !== undefined) result.page = values.page
  if (values.parent !== undefined) result.parent = values.parent
  if (values.out !== undefined) result.out = values.out
  return result
}
