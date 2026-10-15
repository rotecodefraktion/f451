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

  it('rejects invalid file imports', () => {
    expect(() => parseArgs(['markdown', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['obsidian', 'v'])).toThrow(UsageError)
    expect(() => parseArgs(['markdown', 'a', 'b', '--space', 's'])).toThrow(UsageError)
    expect(() => parseArgs(['obsidian', 'v', '--space', 's', '--book', '7'])).toThrow(UsageError)
    expect(() => parseArgs(['markdown', 'd', '--space', 's', '--page', '3'])).toThrow(UsageError)
  })

  it('ignores the separator pnpm passes through', () => {
    expect(parseArgs(['--', 'bookstack', '--book', '7', '--space', 's']).book).toBe('7')
  })
})
