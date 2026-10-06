#!/usr/bin/env node
// FLEETVENV923: print the fleet venv PATH prefix ("<venv>/bin:", or nothing when
// the setting is off or the directory is missing) for the shell launchers,
// through scripts/fleet-venv-prefix.sh.
//
// Resolved by the SAME functions the dashboard's launchers use
// (dist/fleet-venv.js: store/config-overrides.json > .env > off, quotes
// stripped like every other .env read, leading ~ = home). The recovery respawn
// of the main session takes the TypeScript value, so a separate shell-side
// parse let a normal boot and a respawn of the same session get different
// PATHs (#1626 review). The imported module has no logger: stdout carries only
// the prefix; a refused path is reported on stderr.
//
// Usage: node scripts/fleet-venv-prefix.mjs
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { resolveFleetVenvDir, fleetVenvBin } = await import(join(projectRoot, 'dist', 'fleet-venv.js'))

const venvDir = resolveFleetVenvDir(projectRoot)
const { prefix, refused } = fleetVenvBin(venvDir)
if (refused) {
  process.stderr.write(`fleet-venv-prefix: FLEET_PYTHON_VENV (${venvDir}) is not an absolute path or contains a shell-active character; PATH prefix skipped\n`)
}
process.stdout.write(prefix)
