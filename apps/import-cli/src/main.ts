#!/usr/bin/env node
import { parseArgs } from './args.js'
import { runBookStackExport } from './export-bookstack.js'
import { runOfficeExport } from './export-office.js'
import { runBookStackImport } from './import-bookstack.js'
import { runFileImport } from './import-files.js'

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2))
    process.exitCode =
      args.command === 'export'
        ? args.source === 'office'
          ? await runOfficeExport(args, process.env, process.stdout)
          : await runBookStackExport(args, process.env, process.stdout)
        : args.source === 'bookstack'
          ? await runBookStackImport(args, process.env, process.stdout)
          : await runFileImport(args, process.env, process.stdout)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 2
  }
}

void main()
