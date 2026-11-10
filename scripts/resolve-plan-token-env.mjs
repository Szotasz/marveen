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
//
// SUBPLANTOKEN1110, sub-agents: two optional flags after the three positionals.
//   --strict          no fleet fallback: a missing or unreadable plan secret is
//                     exit 1 with NOTHING on stdout (and a FATAL line). A
//                     sub-agent on a token plan must never run on the fleet
//                     token silently -- the launcher's own vault check comes
//                     first, this is the last line if the secret goes between.
//   --status <path>   write the launch outcome as JSON to <path> (atomically:
//                     temp file + rename), for the dashboard's agent state and
//                     the rotate endpoint's answer: {"state":"plan-token"|
//                     "failed","secretId":...,"at":<ms>[,"reason":...]}. The
//                     token value is never in it.
import { readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const argv = process.argv.slice(2)
const [secretId, fleetTokenPath, failuresLogPath] = argv
let strict = false
let statusPath = null
let flagsOk = true
for (let i = 3; i < argv.length; i++) {
  if (argv[i] === '--strict') strict = true
  else if (argv[i] === '--status' && i + 1 < argv.length && argv[i + 1]) statusPath = argv[++i]
  else flagsOk = false
}
if (!secretId || !fleetTokenPath || !failuresLogPath || !flagsOk) {
  process.stderr.write('resolve-plan-token-env: usage: <secretId> <fleetTokenPath> <failuresLogPath> [--strict] [--status <path>]\n')
  process.exit(1)
}

function log(line) {
  const ts = new Date().toLocaleString('sv-SE').replace('T', ' ')
  try { appendFileSync(failuresLogPath, `${ts} resolve-plan-token-env: ${line}\n`) } catch { /* a lost trace line must never be why the launch itself fails */ }
}

function status(state, reason) {
  if (!statusPath) return
  const rec = { state, secretId, at: Date.now(), ...(reason ? { reason } : {}) }
  const tmp = `${statusPath}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 })
    renameSync(tmp, statusPath)
  } catch { log(`could not write the launch status file for plan token id=${secretId}`) }
}

// Dynamic import from compiled dist, same pattern as vault-resolve.mjs and
// main-agent-isolated-config.mjs: a single source of truth for vault access.
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

let planToken = null
try { planToken = getSecret(secretId) } catch { planToken = null }

if (planToken) {
  status('plan-token')
  process.stdout.write(planToken)
  process.exit(0)
}

if (strict) {
  log(`FATAL: vault secret unresolved for plan token id=${secretId} -- strict (sub-agent): no fleet fallback, refusing to start`)
  status('failed', 'vault-secret-unresolved')
  process.exit(1)
}

log(`vault secret unresolved for plan token id=${secretId} -- falling back to the fleet token`)

let fleetToken = ''
try { fleetToken = readFileSync(fleetTokenPath, 'utf-8').trim() } catch { fleetToken = '' }

if (fleetToken) {
  log(`fell back to the fleet token (${fleetTokenPath}) for plan token id=${secretId}`)
  status('fleet-fallback', 'vault-secret-unresolved')
  process.stdout.write(fleetToken)
  process.exit(0)
}

log(`FATAL: no fleet token fallback available either for plan token id=${secretId} -- refusing to start unauthenticated`)
status('failed', 'no-plan-secret-no-fleet-token')
process.exit(1)
