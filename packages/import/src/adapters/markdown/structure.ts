export type Flavor = 'markdown' | 'obsidian' | 'html'

/** A page to build: a note, or a folder (whose content may come from a folder note). */
export interface PlanNode {
  sourceId: string
  title: string
  /** Folder path without trailing slash; set for folder pages. */
  folder?: string
  /** The note that supplies the content (the folder note for a folder page). */
  notePath?: string
  children: PlanNode[]
}

export interface Classified {
  notes: string[]
  attachments: string[]
  /** Files left out on purpose and worth telling the user about. */
  skipped: Array<{ path: string; reason: string }>
}

const NOTE_EXT: Record<Flavor, RegExp> = {
  markdown: /\.md$/i,
  obsidian: /\.md$/i,
  html: /\.html?$/i,
}

/** True if the path (or file name) has the note extension of the flavor. */
export function isNoteName(name: string, flavor: Flavor): boolean {
  return NOTE_EXT[flavor].test(name)
}

/** The file name without the flavor's note extension (the title fallback). */
export function stripNoteExt(name: string, flavor: Flavor): string {
  return name.replace(NOTE_EXT[flavor], '')
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Characters that cannot appear in a link placeholder id (`source:<id>|<url>`)
 *  are percent-encoded; `%` too, so the encoding stays unambiguous. */
function encodeIdPath(path: string): string {
  return path.replace(/[%\s|()<>[\]\\]/gu, (c) =>
    Array.from(new TextEncoder().encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  )
}

/** `markdown:<path>` / `obsidian:<path>` / `html:<path>`; folders end in `/`. */
export function sourceIdFor(flavor: Flavor, path: string, folder = false): string {
  return `${flavor}:${encodeIdPath(path)}${folder ? '/' : ''}`
}

/** Sorts the listing into notes, attachments and files to skip. Paths with a
 *  segment starting with `.` (`.obsidian/`, `.trash/`, `.git/`) are skipped
 *  silently; for Markdown and Obsidian, canvas files and Excalidraw drawings
 *  are reported. For HTML, `.md` files are attachments like any other file. */
export function classifyPaths(paths: string[], flavor: Flavor): Classified {
  const out: Classified = { notes: [], attachments: [], skipped: [] }
  for (const path of paths) {
    if (path.split('/').some((s) => s.startsWith('.'))) continue
    const lower = path.toLowerCase()
    if (flavor !== 'html' && lower.endsWith('.canvas')) out.skipped.push({ path, reason: 'canvas files are not converted' })
    else if (flavor !== 'html' && (lower.endsWith('.excalidraw.md') || lower.endsWith('.excalidraw')))
      out.skipped.push({ path, reason: 'Excalidraw drawings are not converted' })
    else if (isNoteName(path, flavor)) out.notes.push(path)
    else out.attachments.push(path)
  }
  return out
}

const collator = new Intl.Collator('en', { sensitivity: 'base' })

function byTitle(a: PlanNode, b: PlanNode): number {
  return collator.compare(a.title, b.title) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
}

/** Builds the page tree from the notes. Every folder with a note somewhere
 *  below it becomes a page; a folder without notes (an attachment folder)
 *  does not. A folder note — `A/A.md`, `A.md` next to `A/`, `A/index.md`,
 *  `A/README.md`, first match — supplies the folder page's content and is not
 *  a page of its own. For HTML only `A/index.html`, then `A/index.htm` count.
 *  Siblings are ordered by title, case-insensitively. */
export function buildStructure(notes: string[], titleOf: (notePath: string) => string, flavor: Flavor): PlanNode[] {
  const noteSet = new Set(notes)
  const folders = new Set<string>()
  for (const n of notes) {
    for (let d = dirOf(n); d !== ''; d = dirOf(d)) folders.add(d)
  }

  // Shallow folders first, so `A/A.md` goes to `A` rather than as the sibling
  // folder note of `A/A/`.
  const folderNote = new Map<string, string>()
  const claimed = new Set<string>()
  const byDepth = [...folders].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  for (const folder of byDepth) {
    const name = baseOf(folder)
    const parent = dirOf(folder)
    const candidates =
      flavor === 'html'
        ? [`${folder}/index.html`, `${folder}/index.htm`]
        : [
            `${folder}/${name}.md`,
            parent ? `${parent}/${name}.md` : `${name}.md`,
            `${folder}/index.md`,
            `${folder}/README.md`,
          ]
    const hit = candidates.find((c) => noteSet.has(c) && !claimed.has(c))
    if (hit) {
      folderNote.set(folder, hit)
      claimed.add(hit)
    }
  }

  const childFolders = new Map<string, string[]>()
  for (const f of folders) {
    const p = dirOf(f)
    childFolders.set(p, [...(childFolders.get(p) ?? []), f])
  }
  const childNotes = new Map<string, string[]>()
  for (const n of notes) {
    if (claimed.has(n)) continue
    const p = dirOf(n)
    childNotes.set(p, [...(childNotes.get(p) ?? []), n])
  }

  const build = (dir: string): PlanNode[] => {
    const nodes: PlanNode[] = []
    for (const f of childFolders.get(dir) ?? []) {
      const node: PlanNode = { sourceId: sourceIdFor(flavor, f, true), title: baseOf(f), folder: f, children: build(f) }
      const note = folderNote.get(f)
      if (note) node.notePath = note
      nodes.push(node)
    }
    for (const n of childNotes.get(dir) ?? []) {
      nodes.push({ sourceId: sourceIdFor(flavor, n), title: titleOf(n), notePath: n, children: [] })
    }
    return nodes.sort(byTitle)
  }
  return build('')
}
