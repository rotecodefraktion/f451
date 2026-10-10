import { describe, expect, it } from 'vitest'
import { downscaleTarget, UPLOAD_LIMIT_BYTES } from './downscale-image.js'

const MB = 1024 * 1024
const jpeg = (width: number, height: number) => ({ type: 'image/jpeg' as const, width, height, quality: 0.85 })

describe('downscaleTarget', () => {
  it('scales a large landscape JPEG to the max edge', () => {
    expect(downscaleTarget({ type: 'image/jpeg', width: 4032, height: 3024, bytes: 5 * MB }, UPLOAD_LIMIT_BYTES))
      .toEqual(jpeg(2560, 1920))
  })

  it('scales a large portrait JPEG to the max edge', () => {
    expect(downscaleTarget({ type: 'image/jpeg', width: 3024, height: 4032, bytes: 5 * MB }, UPLOAD_LIMIT_BYTES))
      .toEqual(jpeg(1920, 2560))
  })

  it('leaves a JPEG under both limits alone', () => {
    expect(downscaleTarget({ type: 'image/jpeg', width: 2000, height: 1500, bytes: 2 * MB }, UPLOAD_LIMIT_BYTES))
      .toBeNull()
  })

  it('leaves a PNG under the byte limit alone, however large its edges', () => {
    expect(downscaleTarget({ type: 'image/png', width: 1170, height: 2532, bytes: 3 * MB }, UPLOAD_LIMIT_BYTES))
      .toBeNull()
  })

  it('scales a PNG over the byte limit to the max edge as JPEG, rounding', () => {
    expect(downscaleTarget({ type: 'image/png', width: 3000, height: 2000, bytes: 12 * MB }, UPLOAD_LIMIT_BYTES))
      .toEqual(jpeg(2560, 1707))
  })

  it('re-encodes a small HEIC as JPEG without upscaling', () => {
    expect(downscaleTarget({ type: 'image/heic', width: 1000, height: 800, bytes: 1 * MB }, UPLOAD_LIMIT_BYTES))
      .toEqual(jpeg(1000, 800))
  })

  it('ignores non-image types', () => {
    expect(downscaleTarget({ type: 'application/pdf', width: 4000, height: 3000, bytes: 20 * MB }, UPLOAD_LIMIT_BYTES))
      .toBeNull()
  })
})
