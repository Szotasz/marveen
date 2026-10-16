#!/usr/bin/env node
// Resolve a token-mode claude-plan's vault secret to CLAUDE_CODE_OAUTH_TOKEN's
// value at launch time, with a safe failure path.
//
// PR #1304 review (c): the previous inline pipeline
//   printf 'T=%s' '<id>' | node vault-resolve.mjs | cut -d= -f2-
// swallowed vault-resolve's exit 3 (missing secret): empty stdout piped
// through `cut` is still just empty stdout, so CLAUDE_CODE_OAUTH_TOKEN ended
// up exported EMPTY and the session launched exactly the unauthenticated,
// interactive-login state this whole PR exists to prevent -- in all four
// respawn paths (channels.sh, channel-watchdog.sh, stuck-modal-guard.sh,
// channel-monitor.ts's buildMainSessionRespawnCmd), because the vault-resolve
// path is NEW here: a regression of the PR's own symptom, in its quietest form.
//
// Usage: node resolve-plan-token-env.mjs <secretId> <fleetTokenPath> <failuresLogPath>
// Contract (stdout only ever carries a real, usable token, on either path):
//   exit 0, the PLAN's token on stdout -- the vault secret resolved normally.
//   exit 0, the FLEET token on stdout  -- the plan's secret was missing or
//           unreadable; fell back to the fleet setup-token
//           (store/.claude-oauth-token). A line naming the PLAN's secret id
//           (never any value) is appended to failuresLogPath.
//   exit 1, NOTHING on stdout -- neither is available. A FATAL line is
//           appended to failuresLogPath. The caller MUST treat this as fatal
//           (stop the launch) rather than proceed with an empty token -- see
//           each caller's bare `_plan_token=$(...)` assignment, whose own
//           exit status propagates this failure into the `&&` chain that
//           gates the actual `claude` launch.
import { readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const [secretId, fleetTokenPath, failuresLogPath] = process.argv.slice(2)
if (!secretId || !fleetTokenPath || !failuresLogPath) {
  process.stderr.write('resolve-plan-token-env: usage: <secretId> <fleetTokenPath> <failuresLogPath>\n')
  process.exit(1)
}

function log(line) {
  const ts = new Date().toLocaleString('sv-SE').replace('T', ' ')
  try { appendFileSync(failuresLogPath, `${ts} resolve-plan-token-env: ${line}\n`) } catch { /* a lost trace line must never be why the launch itself fails */ }
}

// Dynamic import from compiled dist, same pattern as vault-resolve.mjs and
// main-agent-isolated-config.mjs: a single source of truth for vault access.
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

let planToken = null
try { planToken = getSecret(secretId) } catch { planToken = null }

if (planToken) {
  process.stdout.write(planToken)
  process.exit(0)
}

log(`vault secret unresolved for plan token id=${secretId} -- falling back to the fleet token`)

let fleetToken = ''
try { fleetToken = readFileSync(fleetTokenPath, 'utf-8').trim() } catch { fleetToken = '' }

if (fleetToken) {
  log(`fell back to the fleet token (${fleetTokenPath}) for plan token id=${secretId}`)
  process.stdout.write(fleetToken)
  process.exit(0)
}

log(`FATAL: no fleet token fallback available either for plan token id=${secretId} -- refusing to start unauthenticated`)
process.exit(1)
