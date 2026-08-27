#!/usr/bin/env node
// PreToolUse hook: per-skill access control.
//
// Intercepts Skill tool invocations and blocks calls from agents that are not
// in the skill's allow-list in store/skill-access.json.
//
// Config shape (store/skill-access.json):
//   { "skill-name": ["main-agent", "agent-a"], ... }
//
// Semantics:
//   - Skill absent from config  -> unrestricted (everyone may call it)
//   - Skill present in config   -> ONLY the listed agents may call it
//   - Empty / missing file      -> all skills unrestricted (fail-open)
//   - MAIN_AGENT_ID            -> always allowed regardless of config (fail-safe)
//
// Agent identity is derived from process.cwd():
//   /...marveen/agents/<name>/anything  -> agentId = <name>
//   anything else (repo root, worktrees outside the repo tree, etc.) -> main agent, always allowed
//
// NOTE: sessions running outside the repo tree cannot be
// attributed to a sub-agent and are treated as the main agent (unrestricted).
//
// Blocked calls are logged to store/skill-access-blocked.log.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_PATH = join(REPO_ROOT, 'store', 'skill-access.json')
const BLOCK_LOG = join(REPO_ROOT, 'store', 'skill-access-blocked.log')

// Derive the Marveen agent id from the current working directory.
// Matches agents/<name> anywhere in the path (including nested subdirectories
// such as worktree-isolated sub-agents running from agents/<name>/workspace/...).
// The main agent runs from the repo root, which is not under agents/.
export function deriveAgentIdFromCwd(cwd) {
  const match = cwd.match(/[/\\]agents[/\\]([^/\\]+)([/\\]|$)/)
  return match ? match[1] : null // null = main agent, always allowed
}

// Evaluate whether a Skill call should be allowed.
// config: the parsed skill-access config object, or null (corrupt/unreadable).
// Returns { allow: true } or { deny: true, reason: string }.
export function gateDecision(toolName, toolInput, agentId, config) {
  if (toolName !== 'Skill') return { allow: true }
  if (agentId === null) return { allow: true } // main agent always allowed

  const skillName = String(toolInput?.skill ?? '')
  if (!skillName) return { allow: true }

  if (config === null) {
    return {
      deny: true,
      reason:
        `Skill "${skillName}" blocked: skill-access.json is corrupt or unreadable. ` +
        `Fix the config or remove it to restore access.`,
    }
  }

  if (!(skillName in config)) return { allow: true }

  const allowed = config[skillName]
  if (!Array.isArray(allowed)) return { allow: true } // malformed entry -> fail-open

  if (allowed.includes(agentId)) return { allow: true }

  return {
    deny: true,
    reason:
      `Skill "${skillName}" is restricted. Agent "${agentId}" is not in the access list. ` +
      `Authorized agents: ${allowed.join(', ')}. ` +
      `To grant access, update store/skill-access.json or use the dashboard Skills > Hozzáférés view.`,
  }
}

export function loadConfig(configPath = CONFIG_PATH) {
  let raw
  try {
    raw = readFileSync(configPath, 'utf-8').trim()
  } catch (err) {
    if (err?.code === 'ENOENT') return {} // missing file -> fail-open (not configured)
    logConfigError(`I/O error reading skill-access.json: ${err?.message ?? err}`)
    return null
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed
  } catch (err) {
    // Corrupt JSON in an existing config: fail-closed (deny + loud log)
    logConfigError(`Malformed skill-access.json (JSON parse error): ${err?.message ?? err}`)
    return null
  }
}

function logConfigError(msg) {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    const ts = new Date().toISOString()
    const line = `${ts} CONFIG_ERROR ${msg}\n`
    appendFileSync(BLOCK_LOG, line)
    process.stderr.write(`[skill-access-gate] ${line}`)
  } catch { /* logging is best-effort */ }
}

function logBlocked(skillName, agentId) {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    const ts = new Date().toISOString()
    appendFileSync(BLOCK_LOG, `${ts} BLOCKED skill="${skillName}" agent="${agentId}"\n`)
  } catch { /* logging is best-effort */ }
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
    process.exit(0) // malformed input must never block
  }

  const agentId = deriveAgentIdFromCwd(process.cwd())
  const config = loadConfig()
  const decision = gateDecision(payload?.tool_name, payload?.tool_input, agentId, config)

  if (decision.allow) {
    process.exit(0)
  }

  // Blocked: log and emit deny
  logBlocked(String(payload?.tool_input?.skill ?? ''), agentId ?? 'unknown')
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  }))
  process.exit(0)
}
