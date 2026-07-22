#!/usr/bin/env node
// PreToolUse gate for safe background-orchestration / observation tools.
//
// PROBLEM (2026-07-21): the Bash/MCP/Read/Edit gates silenced those surfaces for
// the dev agent (Bit), but the built-in ORCHESTRATION tools are yet another
// permission surface. Watching a deploy with the Monitor tool prompts the owner
// on Telegram ("Permission: Monitor / Allow / Deny") on every use -- pure noise
// for a read-only "wait until this condition holds" tool. TaskOutput (reading a
// background task's output) and TaskStop (stopping a task the agent itself
// started) are the same class: local, non-destructive, no outside effect.
//
// FIX: auto-allow a small whitelist of safe observation/self-management tools.
// Everything else defers (exit 0, normal flow / prompt) -- fail safe. We never
// hard-deny, so this gate can only REDUCE friction, never newly block a tool.
// Note: ScheduleWakeup / Cron* are intentionally NOT here -- they stay under the
// self-pace governance deny-list.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Local, non-destructive orchestration tools the dev agent calls routinely while
// driving multi-step work (watch a deploy, read/stop its own background jobs).
const SAFE_TOOLS = new Set(['Monitor', 'TaskOutput', 'TaskStop'])

// 'allow' -> auto-approve (no prompt); 'defer' -> no opinion (normal flow / prompt).
export function decide(toolName) {
  return SAFE_TOOLS.has(String(toolName ?? '')) ? 'allow' : 'defer'
}

function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'safe observation/self-management tool (orchestration-safety-gate)',
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
    process.exit(0) // malformed/empty: defer, never crash the tool call
  }
  if (decide(payload?.tool_name) === 'allow') allow()
  process.exit(0) // defer
}
