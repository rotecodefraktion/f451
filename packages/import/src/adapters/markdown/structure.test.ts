import { describe, expect, it } from 'vitest'
import { buildStructure, classifyPaths, sourceIdFor, type PlanNode } from './structure.js'

const fileTitle = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '')

function shape(nodes: PlanNode[]): unknown[] {
  return nodes.map((n) => (n.children.length ? { [n.title]: shape(n.children) } : n.title))
}

describe('classifyPaths', () => {
  it('skips dot paths silently and reports canvas and Excalidraw files', () => {
    const c = classifyPaths([
      '.obsidian/app.json',
      '.trash/old.md',
      'notes/.hidden/x.md',
      'Board.canvas',
      'Drawing.excalidraw.md',
      'Sketch.excalidraw',
      'a.md',
      'img/b.png',
    ], 'markdown')
    expect(c.notes).toEqual(['a.md'])
    expect(c.attachments).toEqual(['img/b.png'])
    expect(c.skipped.map((s) => s.path)).toEqual(['Board.canvas', 'Drawing.excalidraw.md', 'Sketch.excalidraw'])
  })

  it('takes .html and .htm as notes for HTML; .md and canvas files are attachments there', () => {
    const c = classifyPaths(['.git/x.html', 'a.html', 'b/c.HTM', 'README.md', 'Board.canvas', 'img/b.png'], 'html')
    expect(c.notes).toEqual(['a.html', 'b/c.HTM'])
    expect(c.attachments).toEqual(['README.md', 'Board.canvas', 'img/b.png'])
    expect(c.skipped).toEqual([])
  })
})

describe('buildStructure', () => {
  it('turns folders into pages and orders siblings by title, case-insensitively', () => {
    const plan = buildStructure(['b.md', 'A/x.md', 'c/d/e.md', 'Z.md'], fileTitle, 'markdown')
    expect(shape(plan)).toEqual([{ A: ['x'] }, 'b', { c: [{ d: ['e'] }] }, 'Z'])
    expect(plan[0].sourceId).toBe('markdown:A/')
    expect(plan[1].sourceId).toBe('markdown:b.md')
  })

  it('uses the title function for notes and the folder name for folders', () => {
    const plan = buildStructure(['a.md', 'F/F.md', 'F/b.md'], (p) => (p === 'a.md' ? 'Zeta' : `T:${p}`), 'obsidian')
    expect(shape(plan)).toEqual([{ F: ['T:F/b.md'] }, 'Zeta'])
  })

  it('picks the folder note in the given order and does not make it a page', () => {
    const own = buildStructure(['A/A.md', 'A.md', 'A/index.md', 'A/x.md'], fileTitle, 'markdown')
    expect(own.find((n) => n.title === 'A' && n.folder)?.notePath).toBe('A/A.md')
    // `A.md` is not claimed and stays a page of its own.
    expect(own.map((n) => n.sourceId).sort()).toEqual(['markdown:A.md', 'markdown:A/'])

    const sibling = buildStructure(['A.md', 'A/index.md', 'A/x.md'], fileTitle, 'markdown')
    expect(sibling).toHaveLength(1)
    expect(sibling[0].notePath).toBe('A.md')
    expect(shape(sibling)).toEqual([{ A: ['index', 'x'] }])

    const index = buildStructure(['A/index.md', 'A/README.md', 'A/x.md'], fileTitle, 'markdown')
    expect(index[0].notePath).toBe('A/index.md')
    expect(shape(index)).toEqual([{ A: ['README', 'x'] }])

    const readme = buildStructure(['A/README.md', 'A/x.md'], fileTitle, 'markdown')
    expect(readme[0].notePath).toBe('A/README.md')
  })

  it('gives a folder without a folder note no content', () => {
    const plan = buildStructure(['A/x.md'], fileTitle, 'markdown')
    expect(plan[0].notePath).toBeUndefined()
    expect(plan[0].folder).toBe('A')
  })

  it('takes only A/index.html, then A/index.htm, as HTML folder page', () => {
    const htmlTitle = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.html?$/, '')
    const html = buildStructure(['A/index.htm', 'A/index.html', 'A/x.html'], htmlTitle, 'html')
    expect(html[0]).toMatchObject({ sourceId: 'html:A/', notePath: 'A/index.html' })
    expect(shape(html)).toEqual([{ A: ['index', 'x'] }])

    const htm = buildStructure(['A/index.htm', 'A/x.html'], htmlTitle, 'html')
    expect(htm[0].notePath).toBe('A/index.htm')

    // `A.html` next to `A/` and `A/A.html` are ordinary pages; a root `index.html` too.
    const other = buildStructure(['A.html', 'A/A.html', 'index.html'], htmlTitle, 'html')
    expect(other.find((n) => n.folder === 'A')?.notePath).toBeUndefined()
    expect(other.map((n) => n.sourceId).sort()).toEqual(['html:A.html', 'html:A/', 'html:index.html'])
  })

  it('names an HTML folder page by its index title, else by the folder', () => {
    const titles: Record<string, string> = { 'docs/index.html': 'Documentation', 'raw/index.html': 'index' }
    const plan = buildStructure(['docs/index.html', 'raw/index.html', 'raw/x.html'], (p) => titles[p] ?? 'x', 'html')
    expect(plan.map((n) => n.title)).toEqual(['Documentation', 'raw'])
  })

  // Review focus 5: `A.md` next to `A/` is the folder note, so one page only.
  it('makes A.md next to A/ one page, not two with the same title', () => {
    const plan = buildStructure(['A.md', 'A/child.md'], fileTitle, 'obsidian')
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ title: 'A', sourceId: 'obsidian:A/', notePath: 'A.md' })
    expect(shape(plan)).toEqual([{ A: ['child'] }])
  })
})

describe('sourceIdFor', () => {
  it('encodes characters the link placeholder cannot carry', () => {
    expect(sourceIdFor('obsidian', 'My Notes/a (1)|b%.md')).toBe('obsidian:My%20Notes/a%20%281%29%7Cb%25.md')
    expect(sourceIdFor('markdown', 'Ordner/Über.md')).toBe('markdown:Ordner/Über.md')
    expect(sourceIdFor('markdown', 'A', true)).toBe('markdown:A/')
  })
})
