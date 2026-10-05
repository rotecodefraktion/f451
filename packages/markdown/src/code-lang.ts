// Minimal local hast shapes: the package declares no @types/hast dependency
// (render.ts works with local node types as well).
interface HastText {
  type: 'text' | 'comment' | 'doctype' | 'raw'
}

interface Element {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: Array<Element | HastText>
}

interface Root {
  type: 'root'
  children: Array<Element | HastText>
}

/** Languages are plain identifiers (`bash`, `c++`, `objective-c`, `f#`); anything else is not copied into the DOM. */
const LANG = /^[a-z0-9][a-z0-9+#.-]{0,19}$/i

function langOf(pre: Element): string | null {
  const code = pre.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
  const className = code?.properties?.className
  const classes = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? [className] : []
  const lang = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length)
  return lang && LANG.test(lang) ? lang.toLowerCase() : null
}

function walk(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'pre') {
      const lang = langOf(child)
      if (lang) child.properties = { ...child.properties, dataLang: lang }
    }
    walk(child)
  }
}

/**
 * `<pre><code class="language-x">` → `<pre data-lang="x">`. The reading view's
 * code header (`--code-header: on`, theming structure 1) shows the language with
 * `content: attr(data-lang)`; CSS cannot read it from the class. Runs before
 * rehype-sanitize, which allows `dataLang` on `pre` (render.ts).
 */
export function rehypeCodeLang() {
  return (tree: Root) => walk(tree)
}
