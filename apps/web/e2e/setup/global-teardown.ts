import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Playwright-globalTeardown (Plan Task 6): beendet den in `global-setup.ts`
 * gestarteten Stack-Prozess. Ein SIGTERM an den tsx-Prozess läuft in dessen
 * SIGTERM-Handler (`start-stack.ts` → `cleanup`), der `next dev` killt und die
 * Container stoppt (Ryuk ist unter Podman deaktiviert — wir räumen selbst auf).
 * Nach einer Kulanzfrist wird die gesamte Prozessgruppe hart beendet.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = resolve(HERE, '../.stack-state.json')
const PID_FILE = resolve(HERE, '../.stack-pid')

const GRACE_MS = 60_000

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PID_FILE)) return
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
  if (!Number.isFinite(pid) || pid <= 0) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* schon weg */
  }

  const deadline = Date.now() + GRACE_MS
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 500))
  }

  if (isAlive(pid)) {
    // Ganze Gruppe hart beenden (negatives PID = Prozessgruppe des Setups).
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* weg */
      }
    }
  }

  for (const f of [STATE_FILE, PID_FILE]) {
    if (existsSync(f)) rmSync(f)
  }
}
