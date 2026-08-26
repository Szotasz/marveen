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
//   - MAIN_AGENT_ID             -> always allowed regardless of config (fail-safe)
//
// Agent identity is derived from process.cwd():
//   /...marveen/agents/<name>/  -> agentId = <name>
//   anything else (repo root)   -> main agent, always allowed
//
// Blocked calls are logged to store/skill-access-blocked.log.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_PATH = join(REPO_ROOT, 'store', 'skill-access.json')
const BLOCK_LOG = join(REPO_ROOT, 'store', 'skill-access-blocked.log')

// Derive the agent id from the current working directory.
// Sub-agents run from agents/<name>/ so basename = agent name.
// The main agent runs from the repo root, which is not under agents/.
function deriveAgentId() {
  const cwd = process.cwd()
  const match = cwd.match(/[/\\]agents[/\\]([^/\\]+)[/\\]?$/)
  return match ? match[1] : null // null = main agent, always allowed
}

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8').trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {} // missing or malformed -> fail-open (all unrestricted)
  }
}

function allow() {
  process.exit(0)
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
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
    allow() // malformed input must never block
  }

  if (payload?.tool_name !== 'Skill') {
    allow() // only intercept Skill tool calls
  }

  const agentId = deriveAgentId()

  // Main agent is always allowed (fail-safe)
  if (agentId === null) {
    allow()
  }

  const skillName = String(payload?.tool_input?.skill ?? '')
  if (!skillName) {
    allow() // no skill name -> let Claude Code handle the error
  }

  const config = loadConfig()

  // Not in config -> unrestricted
  if (!(skillName in config)) {
    allow()
  }

  const allowed = config[skillName]

  // Malformed entry -> fail-open
  if (!Array.isArray(allowed)) {
    allow()
  }

  if (allowed.includes(agentId)) {
    allow()
  }

  // Blocked
  logBlocked(skillName, agentId)
  deny(
    `Skill "${skillName}" is restricted. Agent "${agentId}" is not in the access list. ` +
    `Authorized agents: ${allowed.join(', ')}. ` +
    `To grant access, update store/skill-access.json or use the dashboard Skills > Access view.`
  )
}
