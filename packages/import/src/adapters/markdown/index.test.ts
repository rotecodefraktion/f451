import { describe, expect, it } from 'vitest'
import type { FileSource } from '../../files/source.js'
import type { ImportNode } from '../../model.js'
import { rewriteLinks } from '../../links.js'
import { loadHtmlTree, loadMarkdownFolderTree, loadObsidianTree } from './index.js'

const enc = new TextEncoder()
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function memSource(files: Record<string, string | Uint8Array>): FileSource {
  return {
    list: async () => Object.keys(files).sort(),
    read: async (path) => {
      const v = files[path]
      if (v === undefined) throw new Error(`not listed: ${path}`)
      return typeof v === 'string' ? enc.encode(v) : v
    },
  }
}

function find(nodes: ImportNode[], title: string): ImportNode {
  for (const n of nodes) {
    if (n.title === title) return n
    const hit = n.children.length ? findOrNull(n.children, title) : null
    if (hit) return hit
  }
  throw new Error(`no page ${title}`)
}

function findOrNull(nodes: ImportNode[], title: string): ImportNode | null {
  try {
    return find(nodes, title)
  } catch {
    return null
  }
}

describe('loadMarkdownFolderTree', () => {
  const files = {
    'README.md': [
      '# Readme',
      '',
      '[Guide](docs/Guide.md#install), [Docs](docs/index.md), [ext](https://example.com)',
      '',
      '![logo](img/logo%20big.png) ![gone](img/gone.png) [missing](nope.md)',
    ].join('\n'),
    'docs/index.md': '# Docs index\n\nAll docs.\n',
    'docs/Guide.md': '---\ntitle: The Guide\ntags: setup, intro\nauthor: someone\n---\nBack [home](../README.md). ![x](<../img/logo big.png>)\n\nTagged #guide, not `#code`.\n',
    'img/logo big.png': PNG,
    'img/unused.png': PNG,
    '.git/HEAD': 'ref: refs/heads/main',
  }

  it('builds the tree with folder notes, titles and order; a folder without notes is no page', async () => {
    const tree = await loadMarkdownFolderTree(memSource(files))
    expect(tree.root.map((n) => n.title)).toEqual(['docs', 'README'])
    const docs = tree.root[0]
    expect(docs.sourceRef).toEqual({ type: 'markdown', id: 'markdown:docs/' })
    expect(docs.markdown).toBe('# Docs index\n\nAll docs.\n')
    expect(docs.children.map((n) => n.title)).toEqual(['The Guide'])
    expect(docs.children[0].sourceRef.id).toBe('markdown:docs/Guide.md')
    expect(tree.root.map((n) => n.order)).toEqual([0, 1])
  })

  it('turns links to notes into placeholders the writer resolves', async () => {
    const tree = await loadMarkdownFolderTree(memSource(files))
    const readme = find(tree.root, 'README')
    expect(readme.markdown).toContain('[Guide](source:markdown:docs/Guide.md|docs/Guide.md#install)')
    expect(readme.markdown).toContain('[Docs](source:markdown:docs/|docs/index.md)')
    expect(readme.markdown).toContain('[ext](https://example.com)')
    const guide = find(tree.root, 'The Guide')
    expect(guide.markdown).toContain('[home](source:markdown:README.md|../README.md)')
    const ids = new Map([['markdown:docs/Guide.md', 'p-guide'], ['markdown:docs/', 'p-docs']])
    const written = rewriteLinks(readme.markdown, ids)
    expect(written).toContain('[[p-guide|Guide]]')
    expect(written).toContain('[[p-docs|Docs]]')
  })

  it('copies attachments to each page, reports missing and unreferenced ones', async () => {
    const tree = await loadMarkdownFolderTree(memSource(files))
    const readme = find(tree.root, 'README')
    const guide = find(tree.root, 'The Guide')
    expect(readme.markdown).toContain('![logo](_media/logo-big.png)')
    expect(readme.media).toEqual([
      { name: 'logo-big.png', bytes: PNG, mime: 'image/png', kind: 'image', ref: '_media/logo-big.png' },
    ])
    expect(guide.media.map((m) => m.name)).toEqual(['logo-big.png'])
    expect(readme.markdown).toContain('![gone](img/gone.png)')
    expect(tree.mediaSkipped).toEqual([{ sourceId: 'markdown:README.md', name: 'img/gone.png', reason: 'not in the archive' }])
    expect(tree.unresolved).toEqual([{ sourceId: 'markdown:README.md', target: 'nope.md' }])
    expect(tree.unreferenced).toEqual(['img/unused.png'])
  })

  it('takes title and tags from the frontmatter and inline tags, and counts the rest', async () => {
    const tree = await loadMarkdownFolderTree(memSource(files))
    const guide = find(tree.root, 'The Guide')
    expect(guide.tags).toEqual(['setup', 'intro', 'guide'])
    expect(guide.markdown.startsWith('# The Guide\n')).toBe(true)
    expect(guide.markdown).not.toContain('author')
    expect(tree.droppedFrontmatter).toEqual({ author: 1 })
  })

  it('skips dot paths, canvas files and Excalidraw drawings', async () => {
    const tree = await loadMarkdownFolderTree(
      memSource({ 'a.md': 'a', '.obsidian/x.md': 'x', 'b.canvas': '{}', 'c.excalidraw.md': 'c' }),
    )
    expect(tree.root.map((n) => n.title)).toEqual(['a'])
    expect(tree.mediaSkipped.map((m) => m.name)).toEqual(['b.canvas', 'c.excalidraw.md'])
    expect(tree.unreferenced).toEqual([])
  })

  // Review focus 4.
  it('strips a UTF-8 BOM and fails undecodable notes without stopping', async () => {
    const tree = await loadMarkdownFolderTree(
      memSource({
        'bom.md': '﻿---\ntitle: With BOM\n---\nText\n',
        'broken.md': new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x41]),
        'ok.md': 'fine',
      }),
    )
    expect(tree.root.map((n) => n.title)).toEqual(['ok', 'With BOM'])
    expect(find(tree.root, 'With BOM').markdown).toBe('# With BOM\n\nText\n')
    expect(tree.failed).toEqual([{ sourceId: 'markdown:broken.md', title: 'broken', reason: 'not valid UTF-8' }])
  })
})

describe('loadObsidianTree', () => {
  const vault = {
    'Home.md': [
      '---',
      'title: Start',
      'tags: [a, "#b"]',
      'aliases: [x]',
      '---',
      'See [[Project Plan]], [[sub/Deep|deep one]], [[Plan]], [[Roadmap]] and [[note]].',
      '',
      '![[pic.png|300]]',
      '',
      '![[doc.pdf]]',
      '',
      '![[gone.png]]',
      '',
      '![[Project Plan#Goals]]',
      '',
      '> [!info] Heads up',
      '> ==Important== text %%secret%% ^blk1',
      '',
      '```',
      '[[Project Plan]] ==no==',
      '```',
    ].join('\n'),
    'Project Plan.md': '## Goals\n',
    'Plan.md': '---\ntitle: Roadmap\n---\nThe plan.\n',
    'Note.md': 'upper',
    'sub/Deep.md': 'Deep ![[pic.png]]',
    'attachments/pic.png': PNG,
    'attachments/doc.pdf': enc.encode('%PDF'),
    'attachments/unused.png': PNG,
    '.obsidian/app.json': '{}',
  }

  it('builds pages from notes only; the attachment folder is no page', async () => {
    const tree = await loadObsidianTree(memSource(vault))
    expect(tree.root.map((n) => n.title)).toEqual(['Note', 'Project Plan', 'Roadmap', 'Start', 'sub'])
    expect(find(tree.root, 'sub').children.map((n) => n.title)).toEqual(['Deep'])
    expect(find(tree.root, 'Start').sourceRef).toEqual({ type: 'obsidian', id: 'obsidian:Home.md' })
    expect(find(tree.root, 'Start').tags).toEqual(['a', 'b'])
    expect(tree.droppedFrontmatter).toEqual({ aliases: 1 })
  })

  it('resolves wikilinks by file name, not by title, and keeps the link text', async () => {
    const tree = await loadObsidianTree(memSource(vault))
    const home = find(tree.root, 'Start').markdown
    expect(home).toContain('[Project Plan](source:obsidian:Project%20Plan.md|/Project%20Plan.md)')
    expect(home).toContain('[deep one](source:obsidian:sub/Deep.md|/sub/Deep.md)')
    // Review focus 2: `Plan.md` has the title "Roadmap"; `[[Roadmap]]` does not resolve.
    expect(home).toContain('[Plan](source:obsidian:Plan.md|/Plan.md)')
    expect(home).toContain('Roadmap and')
    expect(tree.unresolved).toEqual([{ sourceId: 'obsidian:Home.md', target: 'Roadmap' }])
    // Review focus 3: case-insensitive match.
    expect(home).toContain('[note](source:obsidian:Note.md|/Note.md)')
  })

  it('converts embeds to images and links', async () => {
    const tree = await loadObsidianTree(memSource(vault))
    const start = find(tree.root, 'Start')
    expect(start.markdown).toContain('![pic.png](_media/pic.png)')
    expect(start.markdown).toContain('[doc.pdf](_media/doc.pdf)')
    expect(start.markdown).toContain('[Project Plan](source:obsidian:Project%20Plan.md|/Project%20Plan.md#Goals)')
    expect(start.markdown).toContain('gone.png')
    expect(start.media.map((m) => [m.name, m.kind, m.mime])).toEqual([
      ['pic.png', 'image', 'image/png'],
      ['doc.pdf', 'file', 'application/pdf'],
    ])
    // A shared attachment is copied to every page that uses it.
    expect(find(tree.root, 'Deep').media.map((m) => m.name)).toEqual(['pic.png'])
    expect(tree.mediaSkipped).toEqual([{ sourceId: 'obsidian:Home.md', name: 'gone.png', reason: 'not in the archive' }])
    expect(tree.unreferenced).toEqual(['attachments/unused.png'])
  })

  it('converts callouts, highlights, comments and block ids, but not code', async () => {
    const tree = await loadObsidianTree(memSource(vault))
    const md = find(tree.root, 'Start').markdown
    expect(md).toContain('> [!NOTE]\n> **Heads up**\n>\n> **Important** text')
    expect(md).not.toContain('secret')
    expect(md).not.toContain('^blk1')
    expect(md).toContain('```\n[[Project Plan]] ==no==\n```')
  })

  it('prefers the exact case when two notes differ only in case', async () => {
    const tree = await loadObsidianTree(memSource({ 'a.md': '[[case]] [[CASE]]', 'case.md': 'x', 'Case.md': 'y' }))
    const md = find(tree.root, 'a').markdown
    expect(md).toContain('[case](source:obsidian:case.md|/case.md)')
    // No exact-case file `CASE.md`: both match case-insensitively, the shortest wins.
    expect(md).toMatch(/\[CASE\]\(source:obsidian:(case|Case)\.md\|/)
  })

  it('resolves duplicate names by folder, then by shortest path, and reports the latter', async () => {
    const tree = await loadObsidianTree(
      memSource({
        'Linker.md': '[[Dup]] [[y/z/Dup]]',
        'x/Dup.md': 'x',
        'y/z/Dup.md': 'yz',
        'y/z/Other.md': '[[Dup]]',
      }),
    )
    const linker = find(tree.root, 'Linker').markdown
    expect(linker).toContain('[Dup](source:obsidian:x/Dup.md|')
    expect(linker).toContain('[y/z/Dup](source:obsidian:y/z/Dup.md|')
    expect(find(tree.root, 'Other').markdown).toContain('[Dup](source:obsidian:y/z/Dup.md|')
    expect(tree.ambiguous).toEqual([{ sourceId: 'obsidian:Linker.md', target: 'Dup.md', chosen: 'x/Dup.md' }])
  })

  // Review focus 1: notes at the root, attachments in `attachments/`.
  it('creates no page for an attachment folder next to root notes', async () => {
    const tree = await loadObsidianTree(
      memSource({ 'One.md': '![[a.png]]', 'Two.md': 'two', 'attachments/a.png': PNG }),
    )
    expect(tree.root.map((n) => n.title)).toEqual(['One', 'Two'])
    expect(tree.root.every((n) => n.children.length === 0)).toBe(true)
    expect(tree.unreferenced).toEqual([])
  })

  // Review focus 5.
  it('imports A.md next to A/ as the folder page', async () => {
    const tree = await loadObsidianTree(memSource({ 'A.md': 'Folder text', 'A/child.md': 'c' }))
    expect(tree.root).toHaveLength(1)
    expect(tree.root[0].sourceRef.id).toBe('obsidian:A/')
    expect(tree.root[0].markdown).toBe('# A\n\nFolder text\n')
    expect(tree.root[0].children.map((n) => n.title)).toEqual(['child'])
  })
})

describe('loadHtmlTree', () => {
  const site = {
    'index.html': [
      '<html><head><title>Welcome</title></head><body>',
      '<nav><a href="docs/">Nav link</a></nav>',
      '<main><h1>Welcome</h1>',
      '<p><a href="docs/">Docs</a>, <a href="./docs/guide.html#install">Guide</a>, <a href="docs/guide.html?x=1#s">Query</a>,',
      ' <a href="https://example.com/">ext</a>, <a href="missing.html">gone</a></p>',
      '<p><img src="/img/logo.png" alt="logo"> <img src="img/nope.png" alt="nope">',
      ' <img src="https://example.com/r.png" alt="remote"> <img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"></p>',
      '</main></body></html>',
    ].join(''),
    'docs/index.html': '<html><head><title>Docs</title></head><body><p>All docs, <a href="../index.html">home</a>.</p></body></html>',
    'docs/guide.html': [
      '<html><head><title>Guide</title></head><body><article>',
      '<h2 id="install">Install</h2>',
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      '<details><summary>More</summary><p>Folded text</p></details>',
      '<p><img src="../img/logo.png" alt="logo"></p>',
      '</article></body></html>',
    ].join(''),
    'img/logo.png': PNG,
    'img/unused.png': PNG,
    'notes.md': '# not a page here',
  }

  it('builds the tree from HTML files; index.html is the folder page, a root index.html an ordinary page', async () => {
    const tree = await loadHtmlTree(memSource(site))
    expect(tree.root.map((n) => n.title)).toEqual(['Docs', 'Welcome'])
    const docs = tree.root[0]
    expect(docs.sourceRef).toEqual({ type: 'html', id: 'html:docs/' })
    expect(docs.markdown).toContain('All docs')
    expect(docs.children.map((n) => n.title)).toEqual(['Guide'])
    expect(docs.children[0].sourceRef.id).toBe('html:docs/guide.html')
    expect(tree.root[1].sourceRef.id).toBe('html:index.html')
    expect(tree.failed).toEqual([])
  })

  // Review focus 1.
  it('keeps a leading <h1> of <main> as the only title heading and drops the navigation', async () => {
    const tree = await loadHtmlTree(memSource(site))
    const home = find(tree.root, 'Welcome').markdown
    expect(home.startsWith('# Welcome\n')).toBe(true)
    expect(home.match(/^# /gm)).toHaveLength(1)
    expect(home).not.toContain('Nav link')
    expect(find(tree.root, 'Guide').markdown.startsWith('# Guide\n\n## Install')).toBe(true)
  })

  // Review focus 2 and 3.
  it('turns page and folder links into placeholders; the query is dropped, the anchor kept', async () => {
    const tree = await loadHtmlTree(memSource(site))
    const home = find(tree.root, 'Welcome').markdown
    expect(home).toContain('[Docs](source:html:docs/|docs/)')
    expect(home).toContain('[Guide](source:html:docs/guide.html|./docs/guide.html#install)')
    expect(home).toContain('[Query](source:html:docs/guide.html|docs/guide.html#s)')
    expect(home).toContain('[ext](https://example.com/)')
    expect(find(tree.root, 'Docs').markdown).toContain('[home](source:html:index.html|../index.html)')
    expect(tree.unresolved).toEqual([{ sourceId: 'html:index.html', target: 'missing.html' }])
    const written = rewriteLinks(home, new Map([['html:docs/', 'p-docs']]))
    expect(written).toContain('[[p-docs|Docs]]')
  })

  // Review focus 5: a data: image stays as written and is not missing media.
  it('copies relative and root-relative images, leaves remote and data: images alone', async () => {
    const tree = await loadHtmlTree(memSource(site))
    const home = find(tree.root, 'Welcome')
    expect(home.markdown).toContain('![logo](_media/logo.png)')
    expect(home.markdown).toContain('![nope](img/nope.png)')
    expect(home.markdown).toContain('![remote](https://example.com/r.png)')
    expect(home.markdown).toContain('![inline](data:image/png;base64,iVBORw0KGgo=)')
    expect(home.media.map((m) => m.name)).toEqual(['logo.png'])
    expect(find(tree.root, 'Guide').media.map((m) => m.name)).toEqual(['logo.png'])
    expect(tree.mediaSkipped).toEqual([{ sourceId: 'html:index.html', name: 'img/nope.png', reason: 'not in the archive' }])
    expect(tree.unreferenced).toEqual(['img/unused.png', 'notes.md'])
  })

  it('keeps tables and <details> blocks through the converter', async () => {
    const tree = await loadHtmlTree(memSource(site))
    const guide = find(tree.root, 'Guide').markdown
    expect(guide).toMatch(/\| A \| B \|/)
    expect(guide).toMatch(/\| 1 \| 2 \|/)
    expect(guide).toContain('[!NOTE]')
    expect(guide).toContain('**More**')
    expect(guide).toContain('Folded text')
  })

  it('uses index.htm as folder page, falls back to the file name, and makes no page of an image folder', async () => {
    const tree = await loadHtmlTree(
      memSource({ 'A/index.htm': '<p>Folder text</p>', 'A/x.html': '<p>x</p>', 'pics/a.png': PNG }),
    )
    expect(tree.root.map((n) => n.title)).toEqual(['A'])
    expect(tree.root[0].sourceRef.id).toBe('html:A/')
    expect(tree.root[0].markdown).toBe('# A\n\nFolder text\n')
    expect(tree.root[0].children.map((n) => [n.title, n.markdown])).toEqual([['x', '# x\n\nx\n']])
    expect(tree.unreferenced).toEqual(['pics/a.png'])
  })

  // Review focus 4.
  it('decodes a declared ISO-8859-1 page as windows-1252 and fails an undecodable one without stopping', async () => {
    const latin = new Uint8Array([
      ...enc.encode('<html><head><meta charset="iso-8859-1"><title>Latin</title></head><body><p>'),
      0x93,
      ...enc.encode('Hi'),
      0x94,
      ...enc.encode(' Gr'),
      0xfc,
      ...enc.encode('n</p></body></html>'),
    ])
    const tree = await loadHtmlTree(
      memSource({
        'bad.html': new Uint8Array([...enc.encode('<p>'), 0xff, 0xfe, ...enc.encode('</p>')]),
        'latin.html': latin,
        'ok.html': '<p>ok</p>',
      }),
    )
    expect(tree.root.map((n) => n.title)).toEqual(['Latin', 'ok'])
    expect(find(tree.root, 'Latin').markdown).toBe('# Latin\n\n“Hi” Grün\n')
    expect(tree.failed).toEqual([{ sourceId: 'html:bad.html', title: 'bad', reason: 'not decodable as utf-8' }])
  })
})
