import { Node } from '@tiptap/core'
import { youtubeVideoId } from '@f451/markdown'

/**
 * Atomarer Block-Node für eine YouTube-Zeile (Spec §6 Video). Trägt die
 * ORIGINAL-URL als Attribut (nicht nur die Video-ID) — die Serialisierung
 * gibt exakt diese URL als nackte Zeile zurück, damit der Roundtrip auch
 * für youtu.be-Kurzform oder &t=-Parameter byte-identisch bleibt.
 * Editor-Anzeige: statisches Thumbnail + URL (kein Player — die Leseansicht
 * übernimmt das Abspielen).
 */
export const YoutubeEmbed = Node.create({
  name: 'youtubeEmbed',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-url') ?? '',
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div.yt-embed-editor[data-url]' }]
  },

  renderHTML({ node }) {
    const url = String(node.attrs.url ?? '')
    const videoId = youtubeVideoId(url) ?? ''
    return [
      'div',
      { class: 'yt-embed-editor', 'data-url': url },
      ['img', { src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, alt: '' }],
      ['span', { class: 'yt-embed-editor-url' }, url],
    ]
  },
})
