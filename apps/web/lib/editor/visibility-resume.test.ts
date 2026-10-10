import { describe, expect, it } from 'vitest'

import { ClientApiError, SessionExpiredError, type LockInfo } from './client-api.js'
import { resumeAction, settleHeartbeat } from './visibility-resume.js'

const mineInfo: LockInfo = { heldBy: 'Me', expiresAt: '2026-10-10T10:02:00.000Z', mine: true }
const otherInfo: LockInfo = { heldBy: 'Someone', expiresAt: '2026-10-10T10:02:00.000Z', mine: false }

describe('resumeAction', () => {
  it('ok → none', () => {
    expect(resumeAction('ok')).toBe('none')
  })

  it('heldByOther → notifyLocked', () => {
    expect(resumeAction('heldByOther')).toBe('notifyLocked')
  })

  it('error → none (the regular interval retries)', () => {
    expect(resumeAction('error')).toBe('none')
  })
})

describe('settleHeartbeat', () => {
  it('own lock → ok, keeps the server answer', async () => {
    await expect(settleHeartbeat(() => Promise.resolve(mineInfo))).resolves.toEqual({ result: 'ok', info: mineInfo })
  })

  it('lock held by someone else → heldByOther, keeps heldBy for the notice', async () => {
    await expect(settleHeartbeat(() => Promise.resolve(otherInfo))).resolves.toEqual({
      result: 'heldByOther',
      info: otherInfo,
    })
  })

  it('network error (status 0) → error', async () => {
    await expect(settleHeartbeat(() => Promise.reject(new ClientApiError(0, 'network')))).resolves.toEqual({
      result: 'error',
      info: null,
    })
  })

  it('HTTP errors (403, 404, 503) → error', async () => {
    for (const status of [403, 404, 503]) {
      await expect(settleHeartbeat(() => Promise.reject(new ClientApiError(status, 'x')))).resolves.toEqual({
        result: 'error',
        info: null,
      })
    }
  })

  it('expired session (401) → error', async () => {
    await expect(settleHeartbeat(() => Promise.reject(new SessionExpiredError()))).resolves.toEqual({
      result: 'error',
      info: null,
    })
  })
})
