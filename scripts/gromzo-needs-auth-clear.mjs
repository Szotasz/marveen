#!/usr/bin/env node
// GROMZONEEDSAUTH1109: take the Gromzo server's cached needs-auth entry out of a Claude Code config dir before a launch
// that carries the Gromzo channel (channels.sh). The SAME function the dashboard's main-session respawns import
// (dist/web/gromzo-needs-auth.js); why it is needed and what it never touches: the header of src/web/gromzo-needs-auth.ts.
//
// Prints one line on stderr (channels.sh's error log): what it did, or why it left the file alone. Always exits 0:
// a failed cleanup must never block the session's start.
//
// Usage: node scripts/gromzo-needs-auth-clear.mjs <claude config dir>
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
try {
  const dir = process.argv[2]
  if (!dir) {
    process.stderr.write('gromzo-needs-auth: no-op: no config dir given\n')
  } else {
    const { clearGromzoNeedsAuth, describeNeedsAuthClear } = await import(join(projectRoot, 'dist', 'web', 'gromzo-needs-auth.js'))
    process.stderr.write(describeNeedsAuthClear(clearGromzoNeedsAuth(dir)) + '\n')
  }
} catch (err) {
  process.stderr.write(`gromzo-needs-auth: no-op: failed (${err && err.message ? err.message : String(err)})\n`)
}
process.exit(0)
