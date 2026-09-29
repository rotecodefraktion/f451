import { describe, expect, it } from 'vitest'
import { emailFromClaims } from '../src/auth/oidc.js'

describe('emailFromClaims', () => {
  it('prefers the email claim', () => {
    expect(emailFromClaims({ email: 'a@example.org', preferred_username: 'b@example.org' })).toBe('a@example.org')
  })

  it('falls back to preferred_username, then upn, when they look like an address (Entra ID)', () => {
    expect(emailFromClaims({ preferred_username: 'b@example.org' })).toBe('b@example.org')
    expect(emailFromClaims({ preferred_username: 'bob', upn: 'c@example.org' })).toBe('c@example.org')
  })

  it('returns an empty string when nothing looks like an address', () => {
    expect(emailFromClaims({ preferred_username: 'bob' })).toBe('')
    expect(emailFromClaims({ email: '' })).toBe('')
  })
})
