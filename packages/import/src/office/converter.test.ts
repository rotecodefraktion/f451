import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, zipSync } from 'fflate'
import { ConvertError, httpConverter } from './converter.js'

type Call = { url: URL; init: RequestInit | undefined; body: Uint8Array }

function stub(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : new Uint8Array()
    calls.push({ url: new URL(String(input)), init, body })
    return respond()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const bytesResponse = (bytes: Uint8Array, status = 200) =>
  new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status })

async function rejection(p: Promise<unknown>): Promise<ConvertError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(ConvertError)
  return e as ConvertError
}

describe('httpConverter', () => {
  it('posts the file and unpacks the bundle', async () => {
    const zip = zipSync({
      'document.html': strToU8('<p><img src="media/img-1.png"></p>'),
      'media/img-1.png': strToU8('png'),
      'document.odt': strToU8('odt'),
    })
    const { fetchImpl, calls } = stub(() => bytesResponse(zip))
    const bundle = await httpConverter('http://convert:8080/', fetchImpl).toHtml(strToU8('docx'), 'Bericht ü.docx')

    expect(calls).toHaveLength(1)
    const { url, init, body } = calls[0]
    expect(url.origin + url.pathname).toBe('http://convert:8080/convert')
    expect(url.searchParams.get('to')).toBe('html')
    expect(url.searchParams.get('name')).toBe('Bericht ü.docx')
    expect(init?.method).toBe('POST')
    expect(strFromU8(body)).toBe('docx')

    expect(bundle.html).toBe('<p><img src="media/img-1.png"></p>')
    expect([...bundle.media.keys()]).toEqual(['media/img-1.png'])
    expect(strFromU8(bundle.media.get('media/img-1.png')!)).toBe('png')
    expect(bundle.odfExt).toBe('odt')
    expect(strFromU8(bundle.odf)).toBe('odt')
  })

  it('passes the service status and reason on', async () => {
    const { fetchImpl } = stub(() => Response.json({ error: 'LibreOffice failed (1): broken' }, { status: 422 }))
    const e = await rejection(httpConverter('http://convert:8080', fetchImpl).toHtml(strToU8('x'), 'a.docx'))
    expect(e.status).toBe(422)
    expect(e.message).toBe('LibreOffice failed (1): broken')
  })

  it('reports an unreachable service as 502', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const e = await rejection(httpConverter('http://convert:8080', fetchImpl).toHtml(strToU8('x'), 'a.docx'))
    expect(e.status).toBe(502)
  })

  it('rejects an incomplete bundle', async () => {
    const { fetchImpl } = stub(() => bytesResponse(zipSync({ 'document.html': strToU8('<p/>') })))
    const e = await rejection(httpConverter('http://convert:8080', fetchImpl).toHtml(strToU8('x'), 'a.docx'))
    expect(e.status).toBe(502)
  })

  it('sends an export bundle with target and timeout', async () => {
    const { fetchImpl, calls } = stub(() => bytesResponse(strToU8('%PDF')))
    const out = await httpConverter('http://convert:8080', fetchImpl).fromBundle(strToU8('zip'), 'pdf', { timeoutS: 300 })
    expect(strFromU8(out)).toBe('%PDF')
    expect(calls[0].url.searchParams.get('to')).toBe('pdf')
    expect(calls[0].url.searchParams.get('timeout')).toBe('300')
    expect(strFromU8(calls[0].body)).toBe('zip')
  })

  it('omits the timeout when none is given', async () => {
    const { fetchImpl, calls } = stub(() => bytesResponse(strToU8('docx')))
    await httpConverter('http://convert:8080', fetchImpl).fromBundle(strToU8('zip'), 'docx')
    expect(calls[0].url.searchParams.has('timeout')).toBe(false)
  })
})
