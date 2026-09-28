import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Playwright-globalSetup (Plan Task 6): startet `e2e/setup/start-stack.ts` als
 * eigenen tsx-Subprozess (siehe Kopfkommentar dort, warum ein Subprozess) und
 * wartet, bis dessen State-File „bereit" meldet.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(HERE, '../..')
const TSX_BIN = resolve(WEB_DIR, 'node_modules/.bin/tsx')
const STACK_SCRIPT = resolve(HERE, 'start-stack.ts')
const STATE_FILE = resolve(HERE, '../.stack-state.json')
const PID_FILE = resolve(HERE, '../.stack-pid')

const READY_TIMEOUT_MS = 240_000

export default async function globalSetup(): Promise<void> {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE)

  const child = spawn(TSX_BIN, [STACK_SCRIPT], {
    cwd: WEB_DIR,
    // Eigene Prozessgruppe, damit der Teardown notfalls den ganzen Baum killen kann.
    detached: true,
    stdio: 'inherit',
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))

  let childExited = false
  child.on('exit', (code) => {
    childExited = true
    if (!existsSync(STATE_FILE)) {
      console.error(`[global-setup] Stack-Prozess beendete sich vor „bereit" (code ${code})`)
    }
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { ready?: boolean }
      if (state.ready) {
        console.log('[global-setup] Stack bereit.')
        return
      }
    }
    if (childExited) throw new Error('Stack-Prozess ist beendet, bevor er bereit war (siehe Log oben).')
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Timeout: E2E-Stack wurde nicht rechtzeitig bereit.')
}
