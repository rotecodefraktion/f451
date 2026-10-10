#!/usr/bin/env node
import { parseArgs } from './args.js'
import { runBookStackImport } from './import-bookstack.js'

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2))
    process.exitCode = await runBookStackImport(args, process.env, process.stdout)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 2
  }
}

void main()
