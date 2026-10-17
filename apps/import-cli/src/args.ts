import { parseArgs as nodeParseArgs } from 'node:util'

export type OfficeExportFormat = 'docx' | 'pptx' | 'xlsx' | 'pdf'

export interface ParsedArgs {
  command: 'import' | 'export'
  /** With `command: 'export'`: `bookstack` or `office` (Office file export). */
  source: 'bookstack' | 'markdown' | 'obsidian' | 'html' | 'office'
  /** `export office` only. */
  format?: OfficeExportFormat
  /** `export office` only: include the subpages of `--page`. */
  subpages?: boolean
  /** Folder, `.zip` or (`office` only) a single Office file. */
  path?: string
  /** `office` only: split text at H1, one page per slide / sheet. */
  split?: boolean
  /** `office` only: URL of the convert service (`--convert-url`). */
  convertUrl?: string
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
       f451-import markdown <dir|zip> --space <space> [options]
       f451-import obsidian <dir|zip> --space <space> [options]
       f451-import html <dir|zip> --space <space> [options]
       f451-import office <file|dir|zip> --space <space> [--split] [--convert-url <url>] [options]

A path ending in .zip is read as an archive, anything else as a folder
(office: a single Office file is read as one file).

Office options:
  --split               text at H1, one page per slide and per sheet (default: one page per file)
  --convert-url <url>   convert service (default: F451_CONVERT_URL; if unset, a local soffice on the PATH)

Options:
  --parent <pageId>   import below this page
  --update            update pages that were imported before
  --release           release the pages (and apply the order) instead of leaving reviews open
  --dry-run           write nothing to f451; write the converted Markdown to --out
  --out <dir>         directory for the report (default: .)

       f451-import export bookstack --space <space> [--page <pageId>] [--book <id>] [--dry-run] [--out <dir>]

Export options:
  --page <pageId>     export only the subtree below this page
  --book <id>         update this BookStack book (positive integer) instead of creating one
  --dry-run           write nothing to BookStack; write the rendered HTML (<pageId>.html) to --out
  --out <dir>         directory for the report (default: .)

       f451-import export office --space <space> --page <pageId> --format <docx|pptx|xlsx|pdf> [--subpages] [--out <file>]

Office export options (needs a convert service on the server; large exports: use the panel):
  --page <pageId>     the page to export (required)
  --format <format>   docx, pptx, xlsx or pdf (required)
  --subpages          include the subpages
  --out <file>        target file (default: the name the server suggests, in the current directory)

Environment: F451_URL, F451_TOKEN, BOOKSTACK_URL, BOOKSTACK_TOKEN_ID, BOOKSTACK_TOKEN_SECRET
             (markdown, obsidian, html and office need only F451_URL and F451_TOKEN;
             office also reads F451_CONVERT_URL)
`

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`)
    this.name = 'UsageError'
  }
}

const OFFICE_EXPORT_FORMATS = ['docx', 'pptx', 'xlsx', 'pdf']

function parseOfficeExport(values: Record<string, string | boolean | undefined>, positionals: string[]): ParsedArgs {
  if (positionals.length > 2) throw new UsageError(`unexpected argument: ${positionals[2]}`)
  for (const o of ['book', 'shelf', 'parent', 'update', 'release', 'split', 'convert-url', 'dry-run']) {
    if (values[o] !== undefined) throw new UsageError(`--${o} is not valid for export office`)
  }
  if (typeof values.space !== 'string' || !values.space) throw new UsageError('--space is required')
  if (typeof values.page !== 'string' || !values.page) throw new UsageError('--page is required')
  if (typeof values.format !== 'string' || !OFFICE_EXPORT_FORMATS.includes(values.format)) {
    throw new UsageError(`--format must be one of ${OFFICE_EXPORT_FORMATS.join(', ')}`)
  }

  const result: ParsedArgs = {
    command: 'export',
    source: 'office',
    space: values.space,
    page: values.page,
    format: values.format as OfficeExportFormat,
    subpages: values.subpages === true,
    update: false,
    release: false,
    dryRun: false,
  }
  if (typeof values.out === 'string') result.out = values.out
  return result
}

function parseExport(
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): ParsedArgs {
  if (positionals[1] === 'office') return parseOfficeExport(values, positionals)
  if (positionals[1] !== 'bookstack') {
    throw new UsageError(positionals[1] ? `unknown export target: ${positionals[1]}` : 'missing export target')
  }
  if (positionals.length > 2) throw new UsageError(`unexpected argument: ${positionals[2]}`)
  for (const o of ['shelf', 'parent', 'update', 'release', 'split', 'convert-url', 'format', 'subpages']) {
    if (values[o] !== undefined) throw new UsageError(`--${o} is not valid for export`)
  }
  if (typeof values.space !== 'string' || !values.space) throw new UsageError('--space is required')
  if (typeof values.book === 'string' && !/^[1-9][0-9]*$/.test(values.book)) {
    throw new UsageError('--book must be a positive integer')
  }

  const result: ParsedArgs = {
    command: 'export',
    source: 'bookstack',
    space: values.space,
    update: false,
    release: false,
    dryRun: values['dry-run'] === true,
  }
  if (typeof values.book === 'string') result.book = values.book
  if (typeof values.page === 'string') result.page = values.page
  if (typeof values.out === 'string') result.out = values.out
  return result
}

function parseFileImport(
  source: 'markdown' | 'obsidian' | 'html' | 'office',
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): ParsedArgs {
  const path = positionals[1]
  if (!path) throw new UsageError(`missing path for ${source}`)
  if (positionals.length > 2) throw new UsageError(`unexpected argument: ${positionals[2]}`)
  for (const o of ['book', 'shelf', 'page', 'format', 'subpages']) {
    if (values[o] !== undefined) throw new UsageError(`--${o} is not valid for ${source}`)
  }
  if (source !== 'office') {
    for (const o of ['split', 'convert-url']) {
      if (values[o] !== undefined) throw new UsageError(`--${o} is not valid for ${source}`)
    }
  }
  if (typeof values.space !== 'string' || !values.space) throw new UsageError('--space is required')

  const result: ParsedArgs = {
    command: 'import',
    source,
    path,
    space: values.space,
    update: values.update === true,
    release: values.release === true,
    dryRun: values['dry-run'] === true,
  }
  if (typeof values.parent === 'string') result.parent = values.parent
  if (typeof values.out === 'string') result.out = values.out
  if (values.split === true) result.split = true
  if (typeof values['convert-url'] === 'string') result.convertUrl = values['convert-url']
  return result
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
        split: { type: 'boolean' },
        'convert-url': { type: 'string' },
        format: { type: 'string' },
        subpages: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
  const { values, positionals } = parsed

  const command = positionals[0]
  if (command === 'export') return parseExport(values, positionals)
  if (command === 'markdown' || command === 'obsidian' || command === 'html' || command === 'office') {
    return parseFileImport(command, values, positionals)
  }
  if (command !== 'bookstack') {
    throw new UsageError(command ? `unknown command: ${command}` : 'missing command')
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`)
  for (const o of ['split', 'convert-url', 'format', 'subpages'] as const) {
    if (values[o] !== undefined) throw new UsageError(`--${o} is not valid for bookstack`)
  }

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
