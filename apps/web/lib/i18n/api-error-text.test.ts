import { describe, expect, it } from 'vitest'
import { apiErrorText } from './api-error-text.js'
import { t, type DotPaths } from './format.js'
import { de } from './messages/de/index.js'
import { en } from './messages/en/index.js'

const tDe = (key: DotPaths<typeof de>) => t(de, key)
const tEn = (key: DotPaths<typeof en>) => t(en, key)

describe('apiErrorText', () => {
  it('bildet bekannte HTTP-Statuscodes auf den passenden errors-Key ab (DE)', () => {
    expect(apiErrorText(tDe, 400)).toBe(de.errors.bad_request)
    expect(apiErrorText(tDe, 401)).toBe(de.errors.unauthorized)
    expect(apiErrorText(tDe, 403)).toBe(de.errors.forbidden)
    expect(apiErrorText(tDe, 404)).toBe(de.errors.not_found)
    expect(apiErrorText(tDe, 409)).toBe(de.errors.conflict)
    expect(apiErrorText(tDe, 413)).toBe(de.errors.payload_too_large)
    expect(apiErrorText(tDe, 415)).toBe(de.errors.unsupported_media_type)
  })

  it('fällt bei unbekanntem/nicht gelistetem Status auf errors.error zurück', () => {
    expect(apiErrorText(tDe, 500)).toBe(de.errors.error)
    expect(apiErrorText(tDe, 502)).toBe(de.errors.error)
    expect(apiErrorText(tDe, 0)).toBe(de.errors.error) // Netzwerkfehler, s. ClientApiError
  })

  it('funktioniert ebenso mit dem englischen Wörterbuch', () => {
    expect(apiErrorText(tEn, 403)).toBe(en.errors.forbidden)
    expect(apiErrorText(tEn, 409)).toBe(en.errors.conflict)
    expect(apiErrorText(tEn, 999)).toBe(en.errors.error)
  })
})
