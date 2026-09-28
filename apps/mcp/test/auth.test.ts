import { describe, expect, it } from 'vitest'
import { extractToken, MISSING_TOKEN_MESSAGE, tokenFromExtra } from '../src/auth.js'

describe('extractToken', () => {
  it('liest einen f451-Token aus dem Bearer-Header', () => {
    expect(extractToken('Bearer f451_pat_abc123')).toBe('f451_pat_abc123')
  })

  it('akzeptiert das Schema unabhängig von der Schreibweise und ignoriert Randleerzeichen', () => {
    expect(extractToken('  bearer   f451_pat_abc123  ')).toBe('f451_pat_abc123')
  })

  it('weist Bearer-Werte ohne f451-Präfix ab', () => {
    // Wichtig fürs Zusammenspiel mit dem Admin-Token: der wird ebenfalls als
    // Bearer geschickt, darf hier aber NICHT als Nutzer-Token durchgehen.
    expect(extractToken('Bearer irgendein-admin-token')).toBeUndefined()
  })

  it('gibt undefined zurück, wenn der Header fehlt oder kein Bearer ist', () => {
    expect(extractToken(undefined)).toBeUndefined()
    expect(extractToken('Basic dXNlcjpwYXNz')).toBeUndefined()
  })
})

describe('tokenFromExtra', () => {
  it('liefert den durchgereichten Token', () => {
    expect(tokenFromExtra({ authInfo: { token: 'f451_pat_x', clientId: 'f451-mcp', scopes: [] } })).toBe('f451_pat_x')
  })

  it('erklärt bei fehlendem Token, wie der Nutzer eines bekommt', () => {
    expect(() => tokenFromExtra({})).toThrow(MISSING_TOKEN_MESSAGE)
  })
})
