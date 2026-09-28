import { describe, expect, it } from 'vitest'
import { ConflictError, NotFoundError, ProviderError, toProviderError } from '../src/errors.js'

describe('Fehlerkontrakt', () => {
  it('NotFoundError und ConflictError sind ProviderError-Subtypen mit Status', () => {
    const nf = new NotFoundError('datei fehlt')
    const cf = new ConflictError('sha veraltet')
    expect(nf).toBeInstanceOf(ProviderError)
    expect(cf).toBeInstanceOf(ProviderError)
    expect(nf.status).toBe(404)
    expect(cf.status).toBe(409)
  })

  it('toProviderError mappt HTTP-Status auf den passenden Fehlertyp', () => {
    expect(toProviderError(404, 'x')).toBeInstanceOf(NotFoundError)
    expect(toProviderError(409, 'x')).toBeInstanceOf(ConflictError)
    expect(toProviderError(422, 'x')).toBeInstanceOf(ConflictError)
    const other = toProviderError(500, 'kaputt')
    expect(other).toBeInstanceOf(ProviderError)
    expect(other.status).toBe(500)
    expect(other.body).toBe('kaputt')
  })
})
