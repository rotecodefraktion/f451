import { describe, expect, it } from 'vitest'
import { parseArgs, UsageError } from './args.js'

describe('parseArgs', () => {
  it('parses a book import', () => {
    expect(parseArgs(['bookstack', '--book', '7', '--space', 's', '--release'])).toEqual({
      command: 'import',
      source: 'bookstack',
      book: '7',
      space: 's',
      update: false,
      release: true,
      dryRun: false,
    })
  })

  it('parses dry-run, out and parent', () => {
    const a = parseArgs(['bookstack', '--page', '3', '--space', 's', '--dry-run', '--out', 'o', '--parent', 'p1'])
    expect(a).toMatchObject({ page: '3', dryRun: true, out: 'o', parent: 'p1' })
  })

  it('rejects a missing --space', () => {
    expect(() => parseArgs(['bookstack', '--book', '7'])).toThrow(UsageError)
  })

  it('rejects --book together with --shelf', () => {
    expect(() => parseArgs(['bookstack', '--book', '7', '--shelf', '2', '--space', 's'])).toThrow(UsageError)
  })

  it('rejects a missing selector, unknown command and unknown option', () => {
    expect(() => parseArgs(['bookstack', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['export', '--book', '7', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['bookstack', '--book', '7', '--space', 's', '--nope'])).toThrow(UsageError)
  })
  it('parses an export', () => {
    expect(parseArgs(['export', 'bookstack', '--space', 's'])).toEqual({
      command: 'export',
      source: 'bookstack',
      space: 's',
      update: false,
      release: false,
      dryRun: false,
    })
    expect(
      parseArgs(['--', 'export', 'bookstack', '--space', 's', '--page', 'p1', '--book', '4', '--dry-run', '--out', 'o']),
    ).toMatchObject({ command: 'export', page: 'p1', book: '4', dryRun: true, out: 'o' })
  })

  it('rejects invalid exports', () => {
    expect(() => parseArgs(['export', 'bookstack'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'bookstack', '--space', 's', '--book', 'x'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'bookstack', '--space', 's', '--book', '0'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'bookstack', '--space', 's', '--shelf', '2'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'bookstack', '--space', 's', '--release'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'other', '--space', 's'])).toThrow(UsageError)
  })

  it('parses a markdown folder import', () => {
    expect(parseArgs(['markdown', 'docs', '--space', 's'])).toEqual({
      command: 'import',
      source: 'markdown',
      path: 'docs',
      space: 's',
      update: false,
      release: false,
      dryRun: false,
    })
  })

  it('parses an obsidian zip import with all options', () => {
    expect(
      parseArgs([
        '--', 'obsidian', 'vault.zip', '--space', 's', '--parent', 'p1',
        '--update', '--release', '--dry-run', '--out', 'o',
      ]),
    ).toEqual({
      command: 'import',
      source: 'obsidian',
      path: 'vault.zip',
      space: 's',
      parent: 'p1',
      update: true,
      release: true,
      dryRun: true,
      out: 'o',
    })
  })

  it('parses an html folder import', () => {
    expect(parseArgs(['html', 'site', '--space', 's', '--parent', 'p1'])).toEqual({
      command: 'import',
      source: 'html',
      path: 'site',
      space: 's',
      parent: 'p1',
      update: false,
      release: false,
      dryRun: false,
    })
  })

  it('rejects invalid file imports', () => {
    expect(() => parseArgs(['html', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['html', 'site', '--space', 's', '--book', '7'])).toThrow(UsageError)
    expect(() => parseArgs(['markdown', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['obsidian', 'v'])).toThrow(UsageError)
    expect(() => parseArgs(['markdown', 'a', 'b', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['obsidian', 'v', '--space', 's', '--book', '7'])).toThrow(UsageError)
    expect(() => parseArgs(['markdown', 'd', '--space', 's', '--page', '3'])).toThrow(UsageError)
  })

  it('parses an office import', () => {
    expect(parseArgs(['office', 'report.docx', '--space', 's'])).toEqual({
      command: 'import',
      source: 'office',
      path: 'report.docx',
      space: 's',
      update: false,
      release: false,
      dryRun: false,
    })
    expect(
      parseArgs(['office', 'docs.zip', '--space', 's', '--split', '--convert-url', 'http://convert:8080']),
    ).toMatchObject({ source: 'office', path: 'docs.zip', split: true, convertUrl: 'http://convert:8080' })
  })

  it('rejects --split and --convert-url outside office', () => {
    expect(() => parseArgs(['markdown', 'd', '--space', 's', '--split'])).toThrow(UsageError)
    expect(() => parseArgs(['html', 'd', '--space', 's', '--convert-url', 'http://x'])).toThrow(UsageError)
    expect(() => parseArgs(['bookstack', '--book', '7', '--space', 's', '--split'])).toThrow(UsageError)
    expect(() => parseArgs(['office', '--space', 's'])).toThrow(UsageError)
  })

  it('parses an office export', () => {
    expect(parseArgs(['export', 'office', '--space', 's', '--page', 'p1', '--format', 'docx'])).toEqual({
      command: 'export',
      source: 'office',
      space: 's',
      page: 'p1',
      format: 'docx',
      subpages: false,
      update: false,
      release: false,
      dryRun: false,
    })
    expect(
      parseArgs(['export', 'office', '--space', 's', '--page', 'p1', '--format', 'pdf', '--subpages', '--out', 'x.pdf']),
    ).toMatchObject({ format: 'pdf', subpages: true, out: 'x.pdf' })
  })

  it('rejects invalid office exports', () => {
    expect(() => parseArgs(['export', 'office', '--page', 'p1', '--format', 'docx'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'office', '--space', 's', '--format', 'docx'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'office', '--space', 's', '--page', 'p1'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'office', '--space', 's', '--page', 'p1', '--format', 'odt'])).toThrow(UsageError)
    expect(() => parseArgs(['export', 'office', '--space', 's', '--page', 'p1', '--format', 'pdf', '--dry-run'])).toThrow(
      UsageError,
    )
    expect(() => parseArgs(['export', 'bookstack', '--space', 's', '--format', 'pdf'])).toThrow(UsageError)
    expect(() => parseArgs(['markdown', 'd', '--space', 's', '--subpages'])).toThrow(UsageError)
  })

  it('ignores the separator pnpm passes through', () => {
    expect(parseArgs(['--', 'bookstack', '--book', '7', '--space', 's']).book).toBe('7')
  })
})
