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
  it('ignores the separator pnpm passes through', () => {
    expect(parseArgs(['--', 'bookstack', '--book', '7', '--space', 's']).book).toBe('7')
  })
})
