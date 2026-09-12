#!/usr/bin/env node
// Resolve vault secret IDs to plaintext values.
// Reads "ENV_VAR=secret_id" lines from stdin, outputs "ENV_VAR=value" lines.
//
// VAULTNEMA912: this script used to close THREE different worlds with the
// same observable outcome -- exit 0 and empty stdout: a correct call, an
// unknown label, and a malformed line (no '='). A caller could not tell them
// apart, and one real round concluded from the silence that "the vault gives
// no output" and reported a nonexistent outage (Orsi, community-watch #261).
// Failures are loud now, and the worlds stay distinguishable:
//   exit 0  every line resolved; stdout carries ENV_VAR=value lines, nothing
//           is ever logged on the success path
//   exit 2  at least one malformed input line (missing '=') -- the CALLER's
//           bug; the offending line is echoed to stderr (caller-provided
//           text, never vault content)
//   exit 3  at least one label had no secret -- stderr names the LABEL only,
//           NEVER the value of any secret
// Malformed input takes precedence over missing labels in the exit code.
// Resolved lines are still printed even when another line fails, so a
// multi-secret caller sees every problem in one run.
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

// Dynamic import from compiled dist
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

const input = await new Promise(resolve => {
  let data = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', chunk => { data += chunk })
  process.stdin.on('end', () => resolve(data))
})

let malformed = 0
let missing = 0
for (const line of input.trim().split('\n')) {
  if (!line.trim()) continue
  const eq = line.indexOf('=')
  if (eq < 0) {
    // The line is caller-provided text (an env var name and/or a label),
    // never a vault value, so echoing it is safe and names the exact bug.
    process.stderr.write(`vault-resolve: malformed line (no '='), expected ENV_VAR=secret_id: ${line}\n`)
    malformed++
    continue
  }
  const envVar = line.slice(0, eq)
  const secretId = line.slice(eq + 1)
  const value = getSecret(secretId)
  if (value !== null) {
    process.stdout.write(`${envVar}=${value}\n`)
  } else {
    // Label only -- the value does not exist, and even if it did, values
    // must never reach stderr.
    process.stderr.write(`vault-resolve: no secret in the vault for label: ${secretId}\n`)
    missing++
  }
}

if (malformed > 0) process.exit(2)
if (missing > 0) process.exit(3)
