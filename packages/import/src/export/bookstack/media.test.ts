import { describe, expect, it } from 'vitest'
import type { BookStackClient } from '../../adapters/bookstack/client.js'
import { extractMxfile } from '../../adapters/bookstack/drawings.js'
import type { BookStackAttachment, BookStackImage } from '../../adapters/bookstack/types.js'
import { galleryName, isGalleryImage, mediaRefs, uploadAttachments, uploadImages } from './media.js'

type FakeClient = Pick<
  BookStackClient,
  'listGalleryImages' | 'uploadImage' | 'uploadAttachment' | 'getAttachmentsForPage'
>

function fakeClient() {
  const gallery: BookStackImage[] = []
  const attachments: BookStackAttachment[] = []
  const calls = { uploadImage: 0, uploadAttachment: 0 }
  const uploads: Array<{ name: string; bytes: Uint8Array; type: string }> = []
  const client: FakeClient = {
    async listGalleryImages(name) {
      return gallery.filter((i) => i.name.startsWith(name))
    },
    async uploadImage(pageId, name, data, type = 'gallery') {
      calls.uploadImage++
      uploads.push({ name, bytes: new Uint8Array(data), type })
      const img = {
        id: gallery.length + 1,
        name,
        url: `https://bs/uploads/images/gallery/${name}`,
        path: `/uploads/images/gallery/${name}`,
        type,
        uploaded_to: pageId,
        created_at: '',
        updated_at: '',
      }
      gallery.push(img)
      return img
    },
    async uploadAttachment(pageId, name) {
      calls.uploadAttachment++
      const att = {
        id: attachments.length + 1,
        name,
        extension: '',
        uploaded_to: pageId,
        external: false,
        order: 0,
        created_at: '',
        updated_at: '',
      }
      attachments.push(att)
      return att
    },
    async getAttachmentsForPage(pageId) {
      const data = attachments.filter((a) => a.uploaded_to === pageId)
      return { data, total: data.length }
    },
  }
  return { client, calls, uploads }
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('mediaRefs', () => {
  it('collects unique _media refs of images and links', () => {
    expect(mediaRefs('![a](_media/a.png) [doc](_media/d.pdf) ![](_media/a.png) [x](https://e.com/y)')).toEqual([
      '_media/a.png',
      '_media/d.pdf',
    ])
  })
})

describe('galleryName', () => {
  it('prefixes 12 hex chars of the content hash', () => {
    expect(galleryName('a.png', bytes('x'))).toMatch(/^[0-9a-f]{12}-a\.png$/)
    expect(galleryName('a.png', bytes('x')).slice(0, 12)).toBe(galleryName('b.png', bytes('x')).slice(0, 12))
    expect(galleryName('a.png', bytes('x')).slice(0, 12)).not.toBe(galleryName('a.png', bytes('y')).slice(0, 12))
  })
})

describe('isGalleryImage', () => {
  it('treats images and diagram SVGs as gallery, the rest as attachments', () => {
    expect(isGalleryImage('a.PNG')).toBe(true)
    expect(isGalleryImage('flow.drawio.svg')).toBe(true)
    expect(isGalleryImage('d.pdf')).toBe(false)
  })
})

describe('uploadImages', () => {
  it('reuses a gallery image with identical bytes under another name', async () => {
    const { client, calls } = fakeClient()
    const first = await uploadImages(client, 1, [{ name: 'a.png', bytes: bytes('same') }])
    const second = await uploadImages(client, 2, [{ name: 'b.png', bytes: bytes('same') }])
    expect(calls.uploadImage).toBe(1)
    expect(second.get('b.png')?.url).toBe(first.get('a.png')?.url)
  })

  it('uploads different bytes separately', async () => {
    const { client, calls } = fakeClient()
    const urls = await uploadImages(client, 1, [
      { name: 'a.png', bytes: bytes('one') },
      { name: 'b.png', bytes: bytes('two') },
    ])
    expect(calls.uploadImage).toBe(2)
    expect(urls.get('a.png')?.url).not.toBe(urls.get('b.png')?.url)
    expect(urls.get('a.png')?.drawingId).toBeUndefined()
  })

  const plainSvg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>')
  const drawioSvg = bytes(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" content="&lt;mxfile&gt;&lt;diagram/&gt;&lt;/mxfile&gt;">' +
      '<rect width="4" height="4" fill="light-dark(#ff0000,#000000)"/></svg>',
  )

  it('rasterises a plain SVG to a gallery PNG named after the original hash', async () => {
    const { client, uploads } = fakeClient()
    const images = await uploadImages(client, 1, [{ name: 'logo.svg', bytes: plainSvg }])
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.name).toBe(galleryName('logo.png', plainSvg))
    expect(uploads[0]!.type).toBe('gallery')
    expect([...uploads[0]!.bytes.subarray(1, 4)]).toEqual([...bytes('PNG')])
    expect(images.get('logo.svg')?.drawingId).toBeUndefined()
  })

  it('uploads a draw.io SVG as an editable drawing and reuses it by the original hash', async () => {
    const { client, calls, uploads } = fakeClient()
    const first = await uploadImages(client, 1, [{ name: 'flow.drawio.svg', bytes: drawioSvg }])
    expect(uploads[0]!.name).toBe(galleryName('flow.drawio.png', drawioSvg))
    expect(uploads[0]!.type).toBe('drawio')
    expect(extractMxfile(uploads[0]!.bytes)).toBe('<mxfile><diagram/></mxfile>')
    expect(first.get('flow.drawio.svg')).toEqual({ url: expect.any(String), drawingId: 1 })

    const second = await uploadImages(client, 2, [{ name: 'flow.drawio.svg', bytes: drawioSvg }])
    expect(calls.uploadImage).toBe(1)
    expect(second.get('flow.drawio.svg')).toEqual(first.get('flow.drawio.svg'))
  })

  it('treats a draw.io SVG without embedded diagram as a plain image', async () => {
    const { client, uploads } = fakeClient()
    const images = await uploadImages(client, 1, [{ name: 'x.drawio.svg', bytes: plainSvg }])
    expect(uploads[0]!.type).toBe('gallery')
    expect(images.get('x.drawio.svg')?.drawingId).toBeUndefined()
  })
})

describe('uploadAttachments', () => {
  it('skips names the page already has', async () => {
    const { client, calls } = fakeClient()
    const files = [{ name: 'd.pdf', bytes: bytes('pdf'), mime: 'application/pdf' }]
    const first = await uploadAttachments(client, 7, files, 'https://bs/')
    const second = await uploadAttachments(client, 7, files, 'https://bs')
    expect(calls.uploadAttachment).toBe(1)
    expect(first.get('d.pdf')).toBe('https://bs/attachments/1')
    expect(second.get('d.pdf')).toBe('https://bs/attachments/1')
  })
})
