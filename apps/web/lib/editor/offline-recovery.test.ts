import { describe, expect, it } from 'vitest'

import { evaluateOfflineRecovery } from './offline-recovery.js'
import type { OfflineDraft } from './offline-buffer.js'

function buffer(overrides: Partial<OfflineDraft> = {}): OfflineDraft {
  return {
    content: '# Lokal geändert\n',
    baseSha: 'abc123',
    branch: 'draft/home',
    savedAt: '2026-07-15T10:00:00Z',
    ...overrides,
  }
}

describe('evaluateOfflineRecovery', () => {
  it('kein Puffer → none', () => {
    const result = evaluateOfflineRecovery(null, { branch: 'draft/home', content: '# Home\n' })

    expect(result).toBe('none')
  })

  it('identischer Inhalt (gleicher Branch) → none — Aufrufer räumt still, kein Dialog', () => {
    const buffered = buffer({ content: '# Home\n', branch: 'draft/home' })

    const result = evaluateOfflineRecovery(buffered, { branch: 'draft/home', content: '# Home\n' })

    expect(result).toBe('none')
  })

  it('abweichender Inhalt, gleicher Branch → offer', () => {
    const buffered = buffer({ content: '# Lokal geändert\n', branch: 'draft/home' })

    const result = evaluateOfflineRecovery(buffered, { branch: 'draft/home', content: '# Home\n' })

    expect(result).toBe('offer')
  })

  it('fremder Branch (abweichender Inhalt) → offer — konservativ trotz Branch-Wechsel', () => {
    const buffered = buffer({ content: '# Lokal geändert\n', branch: 'draft/home-old' })

    const result = evaluateOfflineRecovery(buffered, { branch: 'draft/home', content: '# Home\n' })

    expect(result).toBe('offer')
  })

  it('identischer Inhalt bei fremdem Branch → none (Inhaltsgleichheit sticht Branch-Prüfung)', () => {
    const buffered = buffer({ content: '# Home\n', branch: 'draft/home-old' })

    const result = evaluateOfflineRecovery(buffered, { branch: 'draft/home', content: '# Home\n' })

    expect(result).toBe('none')
  })
})
