import { editorExtensions } from '@f451/editor'
import type { Node as TiptapNode } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { loadMermaid, mermaidTheme, renderAll, type MermaidResult } from '../mermaid.js'
import type { T } from '../i18n/types.js'

// Live mermaid preview in the WYSIWYG editor (f451#104). The code block stays
// schema-identical to `editorExtensions()`'s CodeBlock (round-trip tests in
// packages/editor depend on it) — only the NodeView is added here. A block with
// language `mermaid` gets a non-editable preview below the editable code.

const RENDER_DELAY_MS = 500

// Unique render ids across all NodeViews — mermaid places a temporary element
// with this id into the document while rendering.
let renderCounter = 0

// mermaid is not reentrant (see `renderAll`), and several mermaid blocks in one
// document render independently — so all editor renders run one after another.
let renderQueue: Promise<unknown> = Promise.resolve()

function currentTheme() {
  const dataTheme = document.documentElement.dataset.theme
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  return mermaidTheme(dataTheme, prefersDark)
}

function isMermaid(node: PmNode): boolean {
  return node.attrs.language === 'mermaid'
}

export function mermaidCodeBlock(t: T) {
  // The web package does not depend on '@tiptap/extension-code-block' directly,
  // so the instance shipped by `editorExtensions()` is extended instead.
  const base = editorExtensions().find((extension) => extension.name === 'codeBlock') as TiptapNode | undefined
  if (!base) throw new Error('editorExtensions() has no codeBlock extension')

  return base.extend({
    addNodeView() {
      const prefix = (this.options as { languageClassPrefix?: string }).languageClassPrefix ?? 'language-'
      return ({ node: initialNode }) => {
        let node = initialNode
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        const setCodeClass = (language: unknown) => {
          if (typeof language === 'string' && language) code.className = `${prefix}${language}`
          else code.removeAttribute('class')
        }
        setCodeClass(node.attrs.language)
        pre.append(code)

        if (!isMermaid(node)) {
          return {
            dom: pre,
            contentDOM: code,
            update: (updated: PmNode) => {
              if (updated.type !== node.type || isMermaid(updated)) return false
              node = updated
              setCodeClass(node.attrs.language)
              return true
            },
          }
        }

        const dom = document.createElement('div')
        dom.className = 'mermaid-node'
        const preview = document.createElement('div')
        preview.className = 'mermaid-preview'
        preview.contentEditable = 'false'
        dom.append(pre, preview)

        let destroyed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let renderedSource: string | null = null

        const render = (source: string) => {
          const id = `mermaid-ed-${++renderCounter}`
          // `renderedSource` is claimed up front (no duplicate render while this one
          // is queued) and released when loading or rendering fails, so the next
          // scheduled render retries the same source (e.g. the mermaid import
          // failed while offline).
          const release = () => {
            if (renderedSource === source) renderedSource = null
          }
          const job = renderQueue.then(async () => {
            if (destroyed) return
            let result: MermaidResult | undefined
            try {
              const renderer = await loadMermaid(currentTheme())
              result = (await renderAll([source], renderer, id))[0]
            } catch (err) {
              release()
              throw err
            }
            if (destroyed) return
            if (!result) {
              release()
              return
            }
            if ('svg' in result) {
              preview.classList.remove('is-error')
              preview.innerHTML = result.svg
            } else {
              preview.classList.add('is-error')
              preview.textContent = t('editor.mermaid.error')
            }
          })
          // A failed import must not block later renders.
          renderQueue = job.catch(() => undefined)
        }

        const schedule = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            const source = node.textContent
            if (source === renderedSource) return
            renderedSource = source
            // An emptied block shows no stale diagram.
            if (!source.trim()) {
              preview.replaceChildren()
              preview.classList.remove('is-error')
              return
            }
            render(source)
          }, RENDER_DELAY_MS)
        }
        schedule()

        return {
          dom,
          contentDOM: code,
          update: (updated: PmNode) => {
            if (updated.type !== node.type || !isMermaid(updated)) return false
            node = updated
            schedule()
            return true
          },
          ignoreMutation: (mutation) => preview.contains(mutation.target),
          destroy: () => {
            destroyed = true
            clearTimeout(timer)
          },
        }
      }
    },
  })
}
