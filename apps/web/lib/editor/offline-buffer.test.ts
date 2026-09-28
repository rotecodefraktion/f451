import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearOfflineDraft, readOfflineDraft, writeOfflineDraft, type OfflineDraft } from './offline-buffer.js'

/** Map-basiertes Fake-localStorage (kein jsdom im Repo; Muster wie die window-Stubs in client-api.test.ts). */
function fakeLocalStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size
    },
  }
}

function draft(overrides: Partial<OfflineDraft> = {}): OfflineDraft {
  return {
    content: '# Home\n',
    baseSha: 'abc123',
    branch: 'draft/home',
    savedAt: '2026-07-15T10:00:00Z',
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writeOfflineDraft / readOfflineDraft / clearOfflineDraft', () => {
  it('Roundtrip: geschriebener Entwurf lässt sich unverändert wieder lesen', () => {
    vi.stubGlobal('window', { localStorage: fakeLocalStorage() })
    const d = draft()

    const ok = writeOfflineDraft('home', d)

    expect(ok).toBe(true)
    expect(readOfflineDraft('home')).toEqual(d)
  })

  it('clearOfflineDraft entfernt den Eintrag; danach liefert readOfflineDraft null', () => {
    vi.stubGlobal('window', { localStorage: fakeLocalStorage() })
    writeOfflineDraft('home', draft())

    clearOfflineDraft('home')

    expect(readOfflineDraft('home')).toBeNull()
  })

  it('korruptes JSON im Slot liefert null UND räumt den Slot (kein erneutes Anfassen bei nächstem Lesen)', () => {
    const store = fakeLocalStorage()
    vi.stubGlobal('window', { localStorage: store })
    store.setItem('f451.offline.home', '{nicht valides json')

    const result = readOfflineDraft('home')

    expect(result).toBeNull()
    expect(store.getItem('f451.offline.home')).toBeNull()
  })

  it('unvollständiges/falsch typisiertes JSON (fehlendes Feld) liefert null und räumt den Slot', () => {
    const store = fakeLocalStorage()
    vi.stubGlobal('window', { localStorage: store })
    store.setItem('f451.offline.home', JSON.stringify({ content: 'x', baseSha: 'abc', branch: 'draft/home' }))

    const result = readOfflineDraft('home')

    expect(result).toBeNull()
    expect(store.getItem('f451.offline.home')).toBeNull()
  })

  it('falscher Feldtyp (z. B. savedAt als Zahl) liefert null und räumt den Slot', () => {
    const store = fakeLocalStorage()
    vi.stubGlobal('window', { localStorage: store })
    store.setItem(
      'f451.offline.home',
      JSON.stringify({ content: 'x', baseSha: 'abc', branch: 'draft/home', savedAt: 12345 }),
    )

    const result = readOfflineDraft('home')

    expect(result).toBeNull()
    expect(store.getItem('f451.offline.home')).toBeNull()
  })

  it('localStorage wirft (Quota-Stub) → writeOfflineDraft liefert false', () => {
    const store = fakeLocalStorage()
    vi.stubGlobal('window', {
      localStorage: {
        ...store,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
      },
    })

    const ok = writeOfflineDraft('home', draft())

    expect(ok).toBe(false)
  })

  it('localStorage.getItem wirft → readOfflineDraft liefert null statt zu werfen (Fix-Runde 1)', () => {
    const store = fakeLocalStorage()
    vi.stubGlobal('window', {
      localStorage: {
        ...store,
        getItem: () => {
          throw new Error('SecurityError')
        },
      },
    })

    expect(readOfflineDraft('home')).toBeNull()
  })

  it('localStorage.removeItem wirft → clearOfflineDraft wirft nicht (Fix-Runde 1; kritisch im Korruptions-Pfad von read)', () => {
    const store = fakeLocalStorage()
    vi.stubGlobal('window', {
      localStorage: {
        ...store,
        removeItem: () => {
          throw new Error('SecurityError')
        },
      },
    })

    expect(() => clearOfflineDraft('home')).not.toThrow()

    // Korruptions-Pfad: read räumt via clearOfflineDraft — ein werfendes removeItem darf dort nicht propagieren.
    store.setItem('f451.offline.home', '{korrupt')
    expect(readOfflineDraft('home')).toBeNull()
  })

  it('Schlüssel-Isolation: zwei pageIds beeinflussen sich nicht gegenseitig', () => {
    vi.stubGlobal('window', { localStorage: fakeLocalStorage() })
    const draftHome = draft({ content: '# Home' })
    const draftAbout = draft({ content: '# About', branch: 'draft/about' })

    writeOfflineDraft('home', draftHome)
    writeOfflineDraft('about', draftAbout)

    expect(readOfflineDraft('home')).toEqual(draftHome)
    expect(readOfflineDraft('about')).toEqual(draftAbout)

    clearOfflineDraft('home')

    expect(readOfflineDraft('home')).toBeNull()
    expect(readOfflineDraft('about')).toEqual(draftAbout)
  })

  it('fehlendes window.localStorage (Node-Umgebung ohne Stub): write liefert false, read liefert null, clear crasht nicht', () => {
    // Kein vi.stubGlobal('window', ...) hier — window ist in dieser Node-Testumgebung nicht definiert.
    expect(writeOfflineDraft('home', draft())).toBe(false)
    expect(readOfflineDraft('home')).toBeNull()
    expect(() => clearOfflineDraft('home')).not.toThrow()
  })

  it('window vorhanden, aber ohne localStorage (z. B. wirft beim Zugriff wie Safari-Private-Mode)', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
    })

    expect(writeOfflineDraft('home', draft())).toBe(false)
    expect(readOfflineDraft('home')).toBeNull()
    expect(() => clearOfflineDraft('home')).not.toThrow()
  })
})
