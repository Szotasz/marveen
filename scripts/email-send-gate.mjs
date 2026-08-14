#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// Why a hook and not a permissions deny-list: permissive security profiles
// launch Claude Code with --dangerously-skip-permissions, which BYPASSES the
// settings.json allow/deny list. A PreToolUse hook runs regardless of
// permission mode, so it is the only reliable mode-independent gate.
//
// This file is wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, and re-applied on every spawn (respawn-safe).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Bash command patterns that send mail. Read-only inspection of these tools
// (e.g. cat'ing the send script) may be caught too -- acceptable: a sub-agent
// has no legitimate need to invoke them, and the gate fails safe toward
// blocking only actual send-shaped commands.
const SEND_PATTERNS = [
  /support-mail\/send\.py/i,
  /\bsend\.py\b/i,
  /api\.resend\.com/i,
  /\bresend\b[^\n]*\b(email|send|message)\b/i,
  /\bsendmail\b/i,
  /\bmsmtp\b/i,
  /\bswaks\b/i,
  /\bsmtplib\b|SMTP\s*\(/i,
  /\bmail\.send\b|\bsendEmail\b/i,
  // graph-mail.ts (PR #668, M365/Exchange Online client-credentials mailbox):
  // its CLI is `tsx scripts/graph-mail.ts send ...`, which none of the above
  // patterns catch (no "sendmail"/"mail.send" substring). Also gate any direct
  // call to the exported sendMail() (e.g. a one-off `node -e`/`tsx -e` that
  // imports the module without going through the CLI).
  /\bgraph-mail\b[^\n]*\bsend\b/i,
  /\bsendMail\s*\(/i,
]

// Outbound-shaped operations of the multiplexed manage_email tool. Each of
// these sends for real unless the call explicitly asks for a draft.
const MANAGE_EMAIL_SEND_OPS = new Set(['send', 'reply', 'replyall', 'forward'])

// Pure decision: does this tool call send (or attempt to send) email?
// Returns { deny, kind? }. `kind` selects the deny wording at the hook
// entrypoint: 'draft-required' is the manage_email case (drafting is fine,
// only the actual send is refused), everything else is the sub-agent
// governance block.
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  if (/send_email/i.test(name)) return { deny: true }
  // @aaronsb/google-workspace-mcp multiplexes read, draft and send behind one
  // manage_email tool, so the tool NAME cannot decide this one -- the operation
  // plus the draft flag can. This is what replaces the server's own
  // draft-only-email safety policy, which blocks drafting too: that policy keys
  // on ctx.operation alone and never looks at draft:true, so with it enabled the
  // mailbox is effectively read-only (verified live, 2026-08-10).
  if (/(^|__)manage_email$/i.test(name)) {
    const op = String(toolInput?.operation ?? '').toLowerCase()
    if (!MANAGE_EMAIL_SEND_OPS.has(op)) return { deny: false }
    // Fail safe: only an explicit draft request passes. A missing/ambiguous
    // flag is treated as a real send, even though the server would itself
    // force a draft when attachments are present.
    const draft = toolInput?.draft
    if (draft === true || draft === 'true') return { deny: false }
    return { deny: true, kind: 'draft-required' }
  }
  if (name === 'Bash') {
    const cmd = String(toolInput?.command ?? '')
    if (SEND_PATTERNS.some((re) => re.test(cmd))) return { deny: true }
  }
  return { deny: false }
}

// Deny wording for the manage_email case. Unlike the sub-agent governance
// block this is not about who the agent is: drafting stays open, so the fix is
// to re-issue the same call with draft: true and hand the draft to the owner.
export function buildDraftOnlyMsg(ownerName) {
  return (
    'Kimeno email kuldese tiltott (draft-kapu). ' +
    'Ird meg ugyanezt draft: true kapcsoloval, es szolj ' +
    `${ownerName}nek, hogy a Gmail piszkozatok kozott varja a jovahagyasat. ` +
    'Csak VERIFIKALT cimre. A kuldes gombot ember nyomja meg.'
  )
}

// Pure builder for the deny message, so the brand/owner substitution is
// provable without spawning the hook. With the stock defaults (botName
// 'Marveen', ownerName 'Szabolcs') the wording is byte-identical to before.
export function buildGateMsg(botName, ownerName) {
  return (
    'Email-kuldes sub-agentkent tiltott (governance hard-gate). ' +
    `Kuldd a tervezett emailt (CIMZETT + TARGY + TELJES SZOVEG) ${botName}nek inter-agent uzenetben ` +
    `jovahagyasra; a kimeno emailt ${botName} kuldi. Csak VERIFIKALT cimre (soha nem nevbol talalt cim). ` +
    `Soha ne irj ala ${ownerName} nevevel, es soha ne kerj penzt senki neveben.`
  )
}

// Resolve the brand + owner display names for the deny message. The hook runs
// standalone (no config.ts), so read the install's .env directly, keyed off
// this file's own location (<root>/scripts/email-send-gate.mjs -> <root>/.env).
// Any failure falls back to the stock defaults, so the gate never breaks and a
// bare install keeps the original wording.
export function readBrandEnv(readFile = (p) => readFileSync(p, 'utf-8')) {
  const fallback = { botName: 'Marveen', ownerName: 'Szabolcs' }
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const raw = readFile(envPath)
    const pick = (key) => {
      const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
      if (!m) return ''
      return m[1].trim().replace(/^["']|["']$/g, '').trim()
    }
    return {
      botName: pick('BOT_NAME') || fallback.botName,
      ownerName: pick('OWNER_NAME') || fallback.ownerName,
    }
  } catch {
    return fallback
  }
}

function allow() { process.exit(0) }

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

// Run as the hook entrypoint only when invoked directly (not when imported by a
// test). Reads the PreToolUse payload from stdin and emits a deny decision for
// email-send tool calls. realpath both sides so a symlinked install path (the
// hook command is an absolute path that may traverse a symlink, e.g. /tmp ->
// /private/tmp on macOS, or a symlinked /home on Linux) still matches -- a raw
// url-vs-argv compare would silently no-op the gate (a security bypass).
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
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny, kind } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) {
    const { botName, ownerName } = readBrandEnv()
    deny(kind === 'draft-required' ? buildDraftOnlyMsg(ownerName) : buildGateMsg(botName, ownerName))
  }
  allow()
}
