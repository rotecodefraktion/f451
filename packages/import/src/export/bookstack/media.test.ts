import { describe, expect, it } from 'vitest'
import type { BookStackClient } from '../../adapters/bookstack/client.js'
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
  const client: FakeClient = {
    async listGalleryImages(name) {
      return gallery.filter((i) => i.name.startsWith(name))
    },
    async uploadImage(pageId, name) {
      calls.uploadImage++
      const img = {
        id: gallery.length + 1,
        name,
        url: `https://bs/uploads/images/gallery/${name}`,
        path: `/uploads/images/gallery/${name}`,
        type: 'gallery',
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
  return { client, calls }
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
    expect(second.get('b.png')).toBe(first.get('a.png'))
  })

  it('uploads different bytes separately', async () => {
    const { client, calls } = fakeClient()
    const urls = await uploadImages(client, 1, [
      { name: 'a.png', bytes: bytes('one') },
      { name: 'b.png', bytes: bytes('two') },
    ])
    expect(calls.uploadImage).toBe(2)
    expect(urls.get('a.png')).not.toBe(urls.get('b.png'))
  })
})

describe('uploadAttachments', () => {
  it('skips names the page already has', async () => {
    const { client, calls } = fakeClient()
    const files = [{ name: 'd.pdf', bytes: bytes('pdf'), mime: 'application/pdf' }]
    await uploadAttachments(client, 7, files)
    await uploadAttachments(client, 7, files)
    expect(calls.uploadAttachment).toBe(1)
  })
})
