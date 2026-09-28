import { describe, expect, it } from 'vitest'
import { createSlugger, slugify } from '../src/slug.js'

describe('slugify', () => {
  it('ersetzt jedes Leerzeichen einzeln (GitHub-Stil, kein Kollabieren)', () => {
    expect(slugify('x  y')).toBe('x--y')
    expect(slugify('x   y')).toBe('x---y')
  })

  it('einzelnes Leerzeichen weiterhin zu einem Bindestrich', () => {
    expect(slugify('x y')).toBe('x-y')
    expect(slugify('Abschnitt Eins')).toBe('abschnitt-eins')
  })

  it('lowercase, Satzzeichen raus, Trim', () => {
    expect(slugify('  Foo Bar! (Baz) ')).toBe('foo-bar-baz')
  })

  it('behält Umlaute/ß statt sie zu verwerfen', () => {
    expect(slugify('Größe ändern')).toBe('größe-ändern')
    expect(slugify('Weiterführende Hinweise')).toBe('weiterführende-hinweise')
    expect(slugify('Straße')).toBe('straße')
  })
})

describe('createSlugger', () => {
  it('vergibt beim ersten Vorkommen den Basis-Slug, danach fortlaufend nummeriert', () => {
    const slugger = createSlugger()
    expect(slugger('Setup')).toBe('setup')
    expect(slugger('Setup')).toBe('setup-1')
    expect(slugger('Setup')).toBe('setup-2')
  })

  it('unabhängige Instanzen zählen unabhängig voneinander', () => {
    const a = createSlugger()
    const b = createSlugger()
    expect(a('Setup')).toBe('setup')
    expect(b('Setup')).toBe('setup')
  })

  it('unterschiedliche Basis-Slugs zählen getrennt', () => {
    const slugger = createSlugger()
    expect(slugger('Setup')).toBe('setup')
    expect(slugger('Deploy')).toBe('deploy')
    expect(slugger('Setup')).toBe('setup-1')
  })
})
