#!/usr/bin/env node
// Provision (idempotently) the MAIN channels-agent's isolated CLAUDE_CONFIG_DIR,
// on any platform once the setting is on and a fleet token exists, then print
// its path on stdout so scripts/channels.sh can export it.
//
// Why: the main agent otherwise keeps the shared ~/.claude and authenticates
// from whatever on-process credential refreshes that shared root -- the
// ROTATING macOS Keychain OAuth session, or (Linux) the shared
// ~/.claude/.credentials.json -- both periodically expire and 401 the main bot
// (a manual /login is then needed), see the 2026-07-23 outage. An isolated
// config dir (no .credentials.json) makes it authenticate from the long-lived
// fleet setup-token via CLAUDE_CODE_OAUTH_TOKEN, exactly like the sub-agents.
//
// Prints NOTHING (and exits 0) when isolation is not applicable -- setting off,
// no fleet token (store/.claude-oauth-token), or ~/.claude absent -- so the
// caller simply keeps the shared root. Mirrors vault-resolve.mjs: dynamic
// import from the compiled dist so there is a single source of truth
// (agent-process.ts).
//
// Usage: node scripts/main-agent-isolated-config.mjs [provider]
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSync, fstatSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

// THE CONTRACT DOES NOT TRAVEL ON STDOUT (2026-09-12 outage). The imported dist
// module logs through pino, and pino writes to fd 1 from its own handle -- a
// pino-pretty transport does it from a WORKER THREAD, so patching
// process.stdout.write in this thread does not catch it (measured). One such
// line ("isolated-config: kept target-only settings keys", newly firing because
// #1218 added `permissions` to the isolated settings.json only) was enough to
// make channels.sh's `[ -d "$_cfg_dir" ]` fail on a multi-line value, and the
// main agent silently kept the shared ~/.claude -- losing BOTH the stable
// fleet-token auth (401 risk) and the isolated dir's own Bash egress deny.
//
// So the callers hand us a THIRD descriptor for the contract (`3>&1 2>>log 1>&2`)
// and let fd 1 and 2 both land in channels-failures.log: the module's diagnostics
// stay readable -- they are deliberately loud, see agent-process.ts -- while
// nothing it prints can reach the contract. Run by hand without that redirection
// (no fd 3), we fall back to stdout so the script stays usable interactively.
let CONTRACT_FD = 3
try { fstatSync(CONTRACT_FD) } catch { CONTRACT_FD = 1 }
const emitContract = (line) => writeSync(CONTRACT_FD, line)

const {
  ensureMainAgentIsolatedConfigDir,
  ensureMainAgentIsolatedConfigDirForRotatedToken,
  resolveMainAgentConfigDir,
  resolveMainAgentRotatedConfigDir,
  resolveMainAgentRotatedTokenSecretId,
} = await import(join(projectRoot, 'dist', 'web', 'agent-process.js'))

// Output contract (consumed by scripts/channels.sh, channel-watchdog.sh,
// stuck-modal-guard.sh): "<mode>\t<path>" for three modes, or
// "token\t<path>\t<tokenSecretId>" (THREE fields) for the fourth. Nothing at
// all when none of the four apply. The mode decides how the caller
// authenticates the agent:
//   explicit -- MAIN_AGENT_CONFIG_DIR, a dir the operator logged into by hand.
//   rotated  -- (PR2c) store/claude-plans-state.json points the main agent at
//               a CONFIGDIR-mode registered plan. Carries ITS OWN
//               .credentials.json (design 6.5/4), so it needs the exact same
//               "do not inject the fleet token" handling as `explicit`.
//   token    -- store/claude-plans-state.json points the main agent at a
//               TOKEN-mode registered plan (ClaudePlan.tokenSecretId). Shares
//               the SAME generic isolated dir as `isolated` below, but the
//               caller must export THAT plan's vault-stored token (resolved
//               via vault-resolve.mjs at launch) instead of the flotta's.
//   isolated -- the credential-less flotta dir, needs the fleet setup-token.
// Precedence: explicit wins outright (it is a deliberate, permanent identity
// choice, never part of the rotation pool -- design 6.2). A rotated plan
// (configDir- or token-mode) wins over plain isolated because a recorded
// rotation is a stronger, more specific signal than the generic flotta
// fallback -- configDir-mode is tried first only because it is the older,
// more specific case; a plan is never both modes at once (validatePlan).
const explicit = resolveMainAgentConfigDir()
if (explicit) {
  emitContract(`explicit\t${explicit}\n`)
} else {
  const rotated = resolveMainAgentRotatedConfigDir()
  if (rotated) {
    emitContract(`rotated\t${rotated}\n`)
  } else {
    const provider = process.argv[2] || undefined
    const tokenSecretId = resolveMainAgentRotatedTokenSecretId()
    if (tokenSecretId) {
      const dir = ensureMainAgentIsolatedConfigDirForRotatedToken(provider)
      if (dir) emitContract(`token\t${dir}\t${tokenSecretId}\n`)
    } else {
      const dir = ensureMainAgentIsolatedConfigDir(provider)
      if (dir) emitContract(`isolated\t${dir}\n`)
    }
  }
}
