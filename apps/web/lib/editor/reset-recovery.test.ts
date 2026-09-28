import { describe, expect, it } from 'vitest'
import { describeResetFailure } from './reset-recovery.js'
import { t as translate } from '../i18n/format.js'
import { de } from '../i18n/messages/de/index.js'
import type { T } from '../i18n/types.js'

// Phase-2-i18n: `describeResetFailure` bekommt `t` als Parameter (Modulkonvention,
// s. `lib/i18n/types.ts#T`) — hier an das DE-Wörterbuch gebunden, dieselbe
// Referenz-Sprache wie der bisherige Test-Wortlaut.
const t: T = (key, params) => translate(de, key, params)

describe('describeResetFailure', () => {
  it('liefert kind:recoverable mit dem geretteten Inhalt, wenn preservedContent gesetzt ist', () => {
    const result = describeResetFailure(
      { ok: false, message: 'Provider nicht erreichbar.', preservedContent: '# Mein Entwurf\n' },
      t,
    )

    expect(result).toEqual({ kind: 'recoverable', preservedContent: '# Mein Entwurf\n' })
  })

  it('liefert kind:recoverable auch bei leerem String (Draft war leer) — kein Verwechseln mit "fehlt"', () => {
    const result = describeResetFailure({ ok: false, message: 'Provider nicht erreichbar.', preservedContent: '' }, t)

    expect(result).toEqual({ kind: 'recoverable', preservedContent: '' })
  })

  it('liefert kind:lost mit der Standardmeldung, wenn preservedContent fehlt (Fehler VOR dem Verwerfen)', () => {
    const result = describeResetFailure({ ok: false, message: 'Provider nicht erreichbar.' }, t)

    expect(result).toEqual({ kind: 'lost', message: t('editor.errors.resetFailed') })
  })
})
