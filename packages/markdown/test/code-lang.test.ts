import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render.js'

// the same resolvers the golden test uses; links and images play no part here
const opts = {
  resolveLink: (t: string) => ({ href: `/pages/${t.toLowerCase()}` }),
  resolveImage: (s: string) => `/media/demo/${s}`,
}

describe('code blocks carry their language as data-lang', () => {
  it('fenced block with a language', () => {
    const html = renderHtml('```bash\nls -la\n```\n', opts)
    expect(html).toContain('<pre data-lang="bash"><code class="language-bash">')
  })

  it('fenced block without a language has no data-lang (Review Focus 5)', () => {
    const html = renderHtml('```\nplain\n```\n', opts)
    expect(html).toContain('<pre><code>')
    expect(html).not.toContain('data-lang')
  })

  it('a language outside the grammar is dropped', () => {
    const html = renderHtml('```<img>\nx\n```\n', opts)
    expect(html).not.toContain('data-lang')
  })
})
