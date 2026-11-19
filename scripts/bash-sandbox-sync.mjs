#!/usr/bin/env node
// WDSANDBOXMARKER1119: the Bash sandbox settings file for one agent, for watchdog.sh's restart, written by the SAME
// function the dashboard's start uses (dist/web/bash-sandbox.js syncBashSandboxSettings): the owner's
// BASH_SANDBOX_AGENTS list (store/config-overrides.json > .env, as the dashboard resolves it) and the owner's host and
// write-path lists decide, never a file left on disk. A listed agent gets its file rewritten from those sources; an
// unlisted one has a stale file removed.
//
// Usage: node scripts/bash-sandbox-sync.mjs <agent-id>
// stdout: exactly one line, "settings=<path>" for a listed agent or "settings=" for an unlisted one. Any failure
// (no dist, an unreadable owner list, a file that cannot be written) exits 1 with the reason on stderr; the watchdog
// then does not start the agent, as the dashboard's start refuses it.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
try {
  const { syncBashSandboxSettings } = await import(join(projectRoot, 'dist', 'web', 'bash-sandbox.js'))
  const file = syncBashSandboxSettings(String(process.argv[2] ?? ''))
  process.stdout.write(`settings=${file ?? ''}\n`)
} catch (err) {
  process.stderr.write(`bash-sandbox-sync: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
