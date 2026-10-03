import { describe, expect, it } from 'vitest'
import { builtinTemplates } from '../src/builtin-themes.js'
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
    })
  }
})
