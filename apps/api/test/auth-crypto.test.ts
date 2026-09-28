import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  API_TOKEN_PREFIX,
  decryptToken,
  encryptToken,
  generateApiToken,
  generateSessionId,
  hashApiToken,
  isApiToken,
} from '../src/auth/crypto.js'

/** 32-Byte-Schlüssel, base64-kodiert (gültig für AES-256-GCM). */
const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64')

describe('Token-Krypto (AES-256-GCM)', () => {
  it('verschlüsselt und entschlüsselt einen Klartext (Roundtrip)', () => {
    const plain = 'gh_super_secret_token_123'
    const enc = encryptToken(plain, KEY)
    expect(decryptToken(enc, KEY)).toBe(plain)
  })

  it('erzeugt das Format v1:<iv>:<tag>:<ct> (alles base64)', () => {
    const enc = encryptToken('hallo-welt', KEY)
    const parts = enc.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    for (const part of parts.slice(1)) {
      expect(() => Buffer.from(part!, 'base64')).not.toThrow()
      expect(Buffer.from(part!, 'base64').length).toBeGreaterThan(0)
    }
  })

  it('liefert bei gleichem Klartext unterschiedliche Ciphertexte (zufälliger IV)', () => {
    const a = encryptToken('gleicher-klartext', KEY)
    const b = encryptToken('gleicher-klartext', KEY)
    expect(a).not.toBe(b)
    expect(decryptToken(a, KEY)).toBe('gleicher-klartext')
    expect(decryptToken(b, KEY)).toBe('gleicher-klartext')
  })

  it('wirft bei falschem Schlüssel', () => {
    const enc = encryptToken('geheim', KEY)
    expect(() => decryptToken(enc, OTHER_KEY)).toThrow()
  })

  describe('Manipulations-Erkennung', () => {
    function flipOneBit(base64Part: string): string {
      const buf = Buffer.from(base64Part, 'base64')
      buf[0] = buf[0]! ^ 0x01
      return buf.toString('base64')
    }

    it('wirft bei Bit-Kipp im IV', () => {
      const enc = encryptToken('geheim', KEY)
      const [v, iv, tag, ct] = enc.split(':')
      const tampered = `${v}:${flipOneBit(iv!)}:${tag}:${ct}`
      expect(() => decryptToken(tampered, KEY)).toThrow()
    })

    it('wirft bei Bit-Kipp im Auth-Tag', () => {
      const enc = encryptToken('geheim', KEY)
      const [v, iv, tag, ct] = enc.split(':')
      const tampered = `${v}:${iv}:${flipOneBit(tag!)}:${ct}`
      expect(() => decryptToken(tampered, KEY)).toThrow()
    })

    it('wirft bei Bit-Kipp im Ciphertext', () => {
      const enc = encryptToken('geheim', KEY)
      const [v, iv, tag, ct] = enc.split(':')
      const tampered = `${v}:${iv}:${tag}:${flipOneBit(ct!)}`
      expect(() => decryptToken(tampered, KEY)).toThrow()
    })
  })

  describe('Schlüssel-Validierung', () => {
    it('wirft beim Verschlüsseln mit falscher Schlüssellänge', () => {
      const shortKey = Buffer.alloc(16, 1).toString('base64')
      expect(() => encryptToken('geheim', shortKey)).toThrow(/32 Byte/)
    })

    it('wirft beim Verschlüsseln mit ungültigem base64', () => {
      expect(() => encryptToken('geheim', 'nicht!!!valides-base64===')).toThrow(/base64/i)
    })

    it('wirft beim Entschlüsseln mit falscher Schlüssellänge', () => {
      const enc = encryptToken('geheim', KEY)
      const shortKey = Buffer.alloc(10, 1).toString('base64')
      expect(() => decryptToken(enc, shortKey)).toThrow(/32 Byte/)
    })

    it('wirft beim Entschlüsseln mit ungültigem base64', () => {
      const enc = encryptToken('geheim', KEY)
      expect(() => decryptToken(enc, 'nicht!!!valides-base64===')).toThrow(/base64/i)
    })
  })

  describe('generateSessionId', () => {
    it('erzeugt eine base64url-kodierte 128-Bit-Zufalls-Id', () => {
      const id = generateSessionId()
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      const decoded = Buffer.from(id, 'base64url')
      expect(decoded.length).toBe(16) // 128 bit
    })

    it('erzeugt bei wiederholtem Aufruf unterschiedliche Ids', () => {
      const ids = new Set(Array.from({ length: 20 }, () => generateSessionId()))
      expect(ids.size).toBe(20)
    })
  })

  describe('API-Tokens (MCP-Phase 0)', () => {
    it('generateApiToken erzeugt ein Präfix-Token mit 256 bit Zufall', () => {
      const token = generateApiToken()
      expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
      const decoded = Buffer.from(token.slice(API_TOKEN_PREFIX.length), 'base64url')
      expect(decoded.length).toBe(32) // 256 bit
    })

    it('erzeugt bei wiederholtem Aufruf unterschiedliche Tokens', () => {
      const tokens = new Set(Array.from({ length: 20 }, () => generateApiToken()))
      expect(tokens.size).toBe(20)
    })

    it('hashApiToken liefert den SHA-256-Hex-Hash des Klartexts (deterministisch)', () => {
      const token = generateApiToken()
      const expected = createHash('sha256').update(token, 'utf8').digest('hex')
      expect(hashApiToken(token)).toBe(expected)
      expect(hashApiToken(token)).toBe(hashApiToken(token))
    })

    it('isApiToken erkennt nur Werte mit f451_pat_-Präfix', () => {
      expect(isApiToken(generateApiToken())).toBe(true)
      expect(isApiToken('irgendein-anderes-geheimnis')).toBe(false)
      expect(isApiToken('')).toBe(false)
    })
  })
})
