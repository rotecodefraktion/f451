import { describe, expect, it } from 'vitest'
import { renderTemplate, templateDatum } from '../src/templates/render.js'

describe('renderTemplate', () => {
  const vars = { titel: 'Team-Sync', autor: 'Erika Muster', datum: '12.07.2026' }

  it('ersetzt alle drei Platzhalter, auch mehrfach', () => {
    const body = '# {{titel}}\n\n{{titel}} am {{datum}} von {{autor}}\n'
    expect(renderTemplate(body, vars)).toBe('# Team-Sync\n\nTeam-Sync am 12.07.2026 von Erika Muster\n')
  })

  it('unbekannte Platzhalter bleiben stehen', () => {
    expect(renderTemplate('{{unbekannt}} {{titel}}', vars)).toBe('{{unbekannt}} Team-Sync')
  })

  it('Ersatzwerte mit $-Zeichen werden literal eingesetzt (kein Regex-Replacement-Muster)', () => {
    expect(renderTemplate('{{titel}}', { ...vars, titel: 'A$&B$1' })).toBe('A$&B$1')
  })
})

describe('templateDatum', () => {
  it('formatiert TT.MM.JJJJ', () => {
    expect(templateDatum(new Date(2026, 6, 5))).toBe('05.07.2026')
  })
})
