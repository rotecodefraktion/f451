/**
 * Decision after the page becomes visible again (app switch, phone locked
 * mid-draft, f451#2). The editor fires one heartbeat at once and acts on
 * its result instead of waiting up to a full heartbeat interval.
 *
 * The lock API needs no separate "take it back" step: `PUT /api/locks/:pageId`
 * (`heartbeatLock`) is an atomic upsert that extends the own lock and takes
 * over an expired one, our own included. So the heartbeat either leaves the
 * lock with us, reports someone else's fresh lock, or fails.
 */
import type { LockInfo } from './client-api.js'

export type HeartbeatResult = 'ok' | 'heldByOther' | 'error'
export type ResumeAction = 'none' | 'notifyLocked'

/** Decision after returning to the page, from the immediate heartbeat. */
export function resumeAction(heartbeat: HeartbeatResult): ResumeAction {
  switch (heartbeat) {
    case 'ok':
      return 'none'
    case 'heldByOther':
      return 'notifyLocked'
    case 'error':
      // The regular heartbeat interval retries.
      return 'none'
  }
}

/** Runs one heartbeat and maps its outcome onto {@link HeartbeatResult}:
 *  `mine: true` → `ok`, `mine: false` → `heldByOther`, any thrown error
 *  (network, 401, 403, 404, 5xx) → `error`. `info` is the server answer when
 *  there was one (carries `heldBy` for the lock notice). */
export async function settleHeartbeat(
  beat: () => Promise<LockInfo>,
): Promise<{ result: HeartbeatResult; info: LockInfo | null }> {
  try {
    const info = await beat()
    return { result: info.mine ? 'ok' : 'heldByOther', info }
  } catch {
    return { result: 'error', info: null }
  }
}
