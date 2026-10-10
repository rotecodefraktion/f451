import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { detectDrawioRenderer, extractMxfile, type Exec } from './drawings.js'

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A 1×1 PNG skeleton (signature, IHDR, extra chunks, IEND); no pixel data
 *  is needed for chunk parsing. */
function png(...extra: Buffer[]): Uint8Array {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return new Uint8Array(Buffer.concat([signature, chunk('IHDR', ihdr), ...extra, chunk('IEND', Buffer.alloc(0))]))
}

const drawingPng = png(chunk('tEXt', Buffer.from('mxfile\0%3Cmxfile%3E%3C%2Fmxfile%3E', 'latin1')))

describe('extractMxfile', () => {
  it('returns the decoded mxfile text chunk', () => {
    expect(extractMxfile(drawingPng)).toBe('<mxfile></mxfile>')
  })

  it('returns null without the chunk', () => {
    expect(extractMxfile(png(chunk('tEXt', Buffer.from('Software\0paint', 'latin1'))))).toBeNull()
  })

  it('returns null for data that is not a PNG', () => {
    expect(extractMxfile(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe('detectDrawioRenderer', () => {
  it('falls back to podman when docker fails', async () => {
    const calls: string[] = []
    const exec: Exec = async (file) => {
      calls.push(file)
      if (file === 'docker') throw new Error('not found')
    }
    expect(await detectDrawioRenderer(exec)).not.toBeNull()
    expect(calls).toEqual(['docker', 'podman'])
  })

  it('returns null when neither engine runs', async () => {
    const exec: Exec = async () => {
      throw new Error('not found')
    }
    expect(await detectDrawioRenderer(exec)).toBeNull()
  })
})
