import { describe, expect, it } from 'vitest'
import { builtinTemplates } from '../src/builtin-themes.js'
import { catalog, tokenNames } from '../src/catalog.js'
import { checkContrast, DEFAULT_THRESHOLDS } from '../src/contrast.js'
import { resolveTheme } from '../src/theme.js'
import { parseThemeFile } from '../src/theme-file.js'

const SLUGS = ['fokus', 'klar-warm', 'system-raster', 'werkbank', 'rotecodefraktion']

describe('built-in theme templates', () => {
  const templates = builtinTemplates()

  it('ships the five templates', () => {
    expect(templates.map((t) => t.slug)).toEqual(SLUGS)
  })

  for (const template of templates) {
    const parsed = parseThemeFile(template.file, 'instance', { allowUse: false })
    // Values below the thresholds are allowed for templates (addendum §3) — they are counted, not failed.
    const findings = checkContrast(resolveTheme([parsed.layer]), DEFAULT_THRESHOLDS)
    const below = findings.filter((f) => f.belowThreshold).length
    const belowAA = findings.filter((f) => f.belowAA).length

    describe(template.slug, () => {
      it('has a name', () => {
        expect(template.name.length).toBeGreaterThan(0)
        expect(template.file.name).toBe(template.name)
      })

      it('parses without errors or warnings', () => {
        expect(parsed.errors).toEqual([])
        expect(parsed.warnings).toEqual([])
        // The generator writes normalised values, so the echo is the file itself.
        expect(parsed.file).toEqual(template.file)
      })

      it(`runs the contrast check (${below} below threshold, ${belowAA} below AA of ${findings.length} pairs)`, () => {
        expect(Array.isArray(findings)).toBe(true)
        expect(findings.length).toBeGreaterThan(0)
      })

      it('sets every building-block switch explicitly', () => {
        const switches = tokenNames.filter((n) => catalog[n].emit === 'attribute').map((n) => n.slice(2))
        expect(switches).toHaveLength(17)
        for (const key of switches) expect(template.file.base?.[key], key).toBeDefined()
      })
    })
  }

  it('carries the construction of its mockup', () => {
    const by = Object.fromEntries(builtinTemplates().map((t) => [t.slug, t.file.base ?? {}]))
    const common = { 'table-style': 'framed', 'card-top-rule': 'off', 'heading-depth': 'top', 'toc-style': 'bar', 'tree-guides': 'off' }
    expect(by.fokus).toMatchObject({ ...common, 'callout-style': 'box', 'button-primary': 'accent', 'chip-style': 'filled', 'heading-number': 'none', 'code-header': 'on', 'rail-blocks': 'plain', 'list-marker': 'disc' })
    expect(by['klar-warm']).toMatchObject({ ...common, 'callout-style': 'box', 'button-primary': 'accent', 'chip-style': 'filled', 'heading-number': 'none', 'code-header': 'on', 'rail-blocks': 'cards', 'list-marker': 'disc' })
    expect(by['system-raster']).toMatchObject({ ...common, 'callout-style': 'bar', 'button-primary': 'accent', 'chip-style': 'marker', 'heading-number': 'none', 'code-header': 'on', 'rail-blocks': 'plain', 'list-marker': 'dash' })
    expect(by.werkbank).toMatchObject({ ...common, 'callout-style': 'box', 'button-primary': 'accent', 'chip-style': 'outline-caps', 'heading-number': 'none', 'code-header': 'on', 'rail-blocks': 'cards', 'list-marker': 'dash' })
    // Rotecodefraktion = the construction the application had before 1.2.5
    expect(by.rotecodefraktion).toMatchObject({ ...common, 'callout-style': 'bar', 'button-primary': 'ink', 'chip-style': 'outline-caps', 'heading-number': 'numeral', 'code-header': 'off', 'rail-blocks': 'plain', 'list-marker': 'disc' })
  })

  it('carries the frame of its mockup', () => {
    const by = Object.fromEntries(builtinTemplates().map((t) => [t.slug, t.file.base ?? {}]))
    expect(by.fokus).toMatchObject({ topbar: 'off', 'page-head': 'title', 'pane-controls': 'edges', 'rail-scroll': 'sticky', 'status-bar': 'off' })
    expect(by['klar-warm']).toMatchObject({ topbar: 'on', 'page-head': 'title', 'pane-controls': 'topbar', 'rail-scroll': 'sticky', 'status-bar': 'off' })
    expect(by['system-raster']).toMatchObject({ topbar: 'off', 'page-head': 'title', 'pane-controls': 'edges', 'rail-scroll': 'sticky', 'status-bar': 'off' })
    expect(by.werkbank).toMatchObject({ topbar: 'on', 'page-head': 'toolbar', 'pane-controls': 'topbar', 'rail-scroll': 'own', 'status-bar': 'bottom' })
    // Rotecodefraktion = the frame of 1.2.5
    expect(by.rotecodefraktion).toMatchObject({ topbar: 'on', 'page-head': 'toolbar', 'pane-controls': 'edges', 'rail-scroll': 'own', 'status-bar': 'off' })
  })
})
