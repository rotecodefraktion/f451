import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import type { Root } from 'mdast'
import { normalizeMarkdown } from '../../normalize.js'
import { alertFor, convertCallouts } from './callouts.js'

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify)

function run(md: string): string {
  const ast = processor.parse(md) as Root
  convertCallouts(ast)
  return normalizeMarkdown(processor.stringify(ast)).markdown
}

describe('alertFor', () => {
  it('maps every Obsidian type group to its GFM alert', () => {
    const groups: Record<string, string[]> = {
      NOTE: ['note', 'info', 'abstract', 'summary', 'tldr', 'todo', 'example', 'quote', 'cite'],
      TIP: ['tip', 'hint', 'success', 'check', 'done'],
      IMPORTANT: ['important', 'question', 'help', 'faq'],
      WARNING: ['warning', 'caution', 'attention', 'bug'],
      CAUTION: ['danger', 'error', 'failure', 'fail', 'missing'],
    }
    for (const [alert, types] of Object.entries(groups)) {
      for (const t of types) expect(alertFor(t)).toBe(alert)
    }
    expect(alertFor('WARNING')).toBe('WARNING')
    expect(alertFor('my-custom')).toBe('NOTE')
  })
})

describe('convertCallouts', () => {
  it('turns a callout without title into a GFM alert', () => {
    expect(run('> [!tip]\n> Body text')).toBe('> [!TIP]\n> Body text\n')
  })

  it('drops the fold marker and makes a custom title a bold first line with the body below', () => {
    expect(run('> [!faq]- Why *this*?\n> Because.')).toBe('> [!IMPORTANT]\n> **Why *this*?**\n>\n> Because.\n')
    expect(run('> [!bug]+ Known issue\n> Details')).toBe('> [!WARNING]\n> **Known issue**\n>\n> Details\n')
  })

  it('keeps later blocks of the callout and maps unknown types to NOTE', () => {
    const out = run('> [!whatever] Title\n>\n> Second paragraph\n> - item')
    expect(out).toContain('> [!NOTE]\n> **Title**')
    expect(out).toContain('> Second paragraph')
    expect(out).toContain('> - item')
  })

  it('maps the danger group to CAUTION and leaves plain quotes alone', () => {
    expect(run('> [!error] Boom')).toBe('> [!CAUTION]\n> **Boom**\n')
    expect(run('> just a quote')).toBe('> just a quote\n')
  })
})
