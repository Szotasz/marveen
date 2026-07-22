#!/usr/bin/env node
// PreToolUse Read safety gate for sandboxed dev fleet agents (e.g. Bit).
//
// PROBLEM (2026-07-21): after Bash/MCP/Edit gates, the Read tool is the FOURTH
// surface that spams the owner with "Permission: Read / Allowed" cards. A dev
// agent doing integration work reads many files (its own workdir AND the Nova
// codebase it integrates with), and every Read fires a card -- only a hook
// 'allow' is silent.
//
// FIX: auto-APPROVE Read within the marveen project + scratch temp (silent),
// DENY reads of secret material (SSH/AWS/GPG keys, .env, dashboard token, vault
// key/store, OTHER agents' .secrets), and DEFER reads outside those roots.
// Bit's OWN agents/bit/.secrets is allowed (it legitimately reads the Nova DEV
// password there for the adapter login).
//
// Wired into the agent's .claude/settings.json PreToolUse "Read" matcher.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize } from 'node:path'

const READ_TOOLS = new Set(['Read'])
// Read is low-risk, so allow the whole project (integration needs to read Nova's
// code) plus scratch temp -- EXCEPT the secret denylist below.
// Includes the fleet launchd plists (~/Library/LaunchAgents/) -- the dev agent
// reads the adapter plist (BRIDGE_URL etc.) for infra/cutover work; plists are
// config (they reference secret FILES by path, never inline secrets). The secret
// denylist below still applies inside every root.
const ALLOWED_ROOTS = [
  '/Users/macmini/marveen/', '/tmp/', '/private/tmp/',
  '/Users/macmini/Library/LaunchAgents/',
]
// Secret material that must NEVER be silently read (deny even inside a root).
// NOTE: agents/bit/.secrets is intentionally NOT denied (the agent's own creds).
const SECRET_PATH = new RegExp([
  '/\\.ssh/', '/\\.aws/', '/\\.gnupg/', 'id_rsa', 'id_ed25519', '\\.pem$',
  '\\.dashboard-token', '\\.vault-key', '/vault\\.json',
  '/marveen/store/',                    // dashboard token, vault, sqlite db
  '/agents/(?!bit/)[^/]+/\\.secrets/',  // OTHER agents' secrets (bit's own allowed)
].join('|'), 'i')

// NARROW EXCEPTION inside the otherwise fully-denied store/ (2026-07-22, Nova GO):
// the PM attachment mirror. The bridge adapter pulls a task's uploaded files here
// (see nova-adapter/bridge-adapter.mjs `attachmentDir` -- same literal path), and
// the fleet agent working the card has to be able to open them. Nothing else under
// store/ opens up: the dashboard token, vault.json and the sqlite db stay denied.
const ATTACHMENT_DIR = '/Users/macmini/marveen/store/kanban-attachments/'

// The exception holds only if the path is inside the mirror AND is still inside it
// after symlink resolution -- otherwise a link planted in the mirror would reach the
// sibling secrets (../.dashboard-token, ../vault.json) through an "allowed" prefix.
// An unresolvable path (missing file, dangling link) gets NO exception and falls
// through to the normal deny/allow logic: default-deny, never default-allow.
function isMirroredAttachment(norm) {
  if (!norm.startsWith(ATTACHMENT_DIR)) return false
  try {
    return realpathSync(norm).startsWith(realpathSync(ATTACHMENT_DIR) + '/')
  } catch {
    return false
  }
}

// Pure decision: 'allow' (silent) | 'deny' | 'defer' (normal prompt).
export function gateDecision(toolName, toolInput) {
  if (!READ_TOOLS.has(String(toolName ?? ''))) return { decision: 'defer' }
  const p = toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path
  if (typeof p !== 'string' || !p) return { decision: 'defer' }
  const norm = normalize(p)
  // Checked BEFORE the secret denylist -- it is the one carve-out from '/marveen/store/'.
  // `normalize` has already collapsed any '..', so a traversal out of the mirror is
  // re-tested against SECRET_PATH below rather than riding this allow.
  if (isMirroredAttachment(norm)) return { decision: 'allow' }
  if (SECRET_PATH.test(norm)) return { decision: 'deny', reason: SECRET_MSG }
  if (norm.startsWith('/')) {
    if (ALLOWED_ROOTS.some((r) => norm.startsWith(r))) return { decision: 'allow' }
    return { decision: 'defer' } // absolute path outside project -> normal prompt
  }
  if (norm.startsWith('..')) return { decision: 'defer' } // climbs out of cwd
  return { decision: 'allow' } // relative within the agent workdir
}

const SECRET_MSG =
  'Titok-anyag olvasasa (SSH/AWS/GPG kulcs, .pem, dashboard-token, vault, store/, ' +
  'mas agens .secrets) TILTOTT. Ha hitelesito adat kell, kerd a Nova Fonoktol.'

function emitAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'safe read (read-safety-gate)',
    },
  }))
  process.exit(0)
}

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    process.exit(0)
  }
  if (!READ_TOOLS.has(String(payload?.tool_name ?? ''))) process.exit(0)
  const { decision, reason } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (decision === 'deny') emitDeny(reason)
  if (decision === 'allow') emitAllow()
  process.exit(0)
}
