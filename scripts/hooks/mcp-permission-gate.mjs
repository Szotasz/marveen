#!/usr/bin/env node
// PreToolUse MCP permission gate for restricted fleet agents.
//
// PROBLEM (2026-07-20): the Bash safety gate silenced Bash prompts, but MCP tool
// calls are a SEPARATE permission surface. A background agent driven over a chat
// channel prompts on EVERY non-allowlisted MCP tool -- including replying to the
// operator (mcp__plugin_telegram_telegram__reply). Getting a permission card just
// to answer a message is absurd friction, and MCP tool names have no wildcard in
// the settings allow-list, so hand-listing ~40 read tools is unmaintainable.
//
// FIX: classify MCP tools by intent.
//   - channel communication (reply/react/edit/download on the chat plugin) -> ALLOW
//   - clearly READ-ONLY tools (get/list/search/read/insights/...) -> ALLOW
//   - WRITE / mutating tools (create/update/delete/send/activate/boost/...) -> DEFER
//     (exit 0, no opinion) so the NORMAL prompt still fires -- a money-spending or
//     outbound-write action SHOULD get a human tap. We never hard-deny here, so the
//     gate can only REDUCE friction, never newly block a tool.
//   - anything we cannot confidently classify -> DEFER (fail safe = prompt).
//
// Non-MCP tools (Bash, Read, Write, ...) are out of scope -> DEFER. Bash has its
// own gate (bash-safety-gate.mjs); money-writes on Meta-Ads land on the prompt,
// which is the intended approval point.

import { readFileSync, realpathSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Chat-channel plugin tools: the agent MUST be able to talk to its operator and
// handle inbound attachments without a prompt. All are low-risk (messaging on the
// operator's own channel).
const CHANNEL_ALLOW = /^mcp__plugin_(telegram|slack|discord|googlechat|teams)[a-z_]*__(reply|react|edit_message|download_attachment|send|typing)/i

// WRITE / mutating verbs. Checked FIRST so a tool that contains both (rare) is
// treated as a write (fail safe -> prompt). Word boundary in the tool short-name
// is EITHER '_' OR '-' (MCP servers vary: Meta-Ads uses snake_case, Canva uses
// kebab-case like `create-design`) so `get_datasets` isn't caught by a stray
// "set" but `create-design` IS caught. (2026-07-21: hyphenated Canva tools all
// deferred because the boundary was underscore-only.)
const WRITE_VERB = /(?:^|[_-])(create|update|delete|remove|destroy|activate|deactivate|enable|disable|boost|pause|resume|archive|respond|apply|label|unlabel|copy|move|send|add|set|upload|import|assign|revoke|approve|publish|merge|resize|comment|reply)(?:[_-]|$)/i

// READ verbs. Only these auto-allow; everything else defers (prompt).
const READ_VERB = /(?:^|[_-])(get|list|search|read|fetch|download|describe|preview|check|count|find|query|export|insights|report|reports|realtime|library|suggest|details|stats|quality|health|context|logs|log|benchmark|score|errors|error|article|articles|activity|eligibility|metadata|permissions|labels|drafts|threads|events|calendars|accounts|entities|images|videos|creatives|audience|audiences|conversions|datasets|dataset|media|pages|resolve|help)(?:[_-]|$)/i

// The tool short-name is the segment after the LAST '__' (server-qualified name).
export function shortName(toolName) {
  const s = String(toolName ?? '')
  const i = s.lastIndexOf('__')
  return i >= 0 ? s.slice(i + 2) : s
}

// 'allow' -> auto-approve (no prompt); 'defer' -> no opinion (normal flow / prompt).
// Canva creative agent (e.g. Lumen): design work IS the job -- create/generate/
// edit/export in the user's OWN Canva account is low-risk and reversible, so
// auto-allow it. Keep the human gate ONLY on outbound/irreversible actions
// (publish a brand template, delete). Without this, a creative agent would prompt
// the owner on every design op and couldn't work autonomously.
const CANVA = /__claude_ai_Canva__/i
const CANVA_GATED = /(?:^|[_-])(publish|delete|remove|destroy)(?:[_-]|$)/i

// Money-spending ad servers (Meta / Google Ads). A WRITE verb on these mutates a
// live, billed ad account (create/update/pause/budget/bid a campaign) -> HARD-DENY
// for sub-agents: no dialog fires, so nothing is forwarded to the owner's chat, and
// the op never runs autonomously. The agent must instead PROPOSE it via the fleet
// /api/approvals flow to Nova (per its CLAUDE.md). READ verbs on these servers still
// auto-allow (reporting is safe). This is the only DENY the gate emits.
const ADS_SERVER = /^mcp__(meta-ads|google-ads|googleads)[a-z0-9_-]*__/i
// Ad-specific mutating verbs not in the generic WRITE_VERB list. `mutate` is the
// Google Ads API's standard write op (GoogleAdsService.Mutate); bid/budget/spend
// name a money change even without a create/update prefix.
const ADS_WRITE_EXTRA = /(?:^|[_-])(mutate|bid|budget|spend|charge)(?:[_-]|$)/i

// --- Temporary, scoped ads-write grant (2026-07-22) --------------------------
//
// Zsolt authorised ONE campaign's worth of Meta-Ads writes for Pixel. This is the
// only way an ads write can ever be allowed, and every clause below must pass --
// anything missing, unparseable or ambiguous falls through to the normal DENY.
// No grant file (the default) means this code changes nothing at all.
//
// The grant is deliberately not a boolean: it names the agent, the server, the
// exact ad account(s), and an expiry. It cannot be left open by forgetting,
// because it stops working on its own at `expires_at`.
export const GRANT_FILE = '/Users/macmini/marveen/store/ads-write-grant.json'
export const GRANT_LOG = '/Users/macmini/marveen/store/logs/ads-write-grant.jsonl'

// Even inside the grant, these are never allowed: deleting a campaign is not a
// budget change, it destroys history and cannot be undone from the API.
const ADS_DESTRUCTIVE = /(?:^|[_-])(delete|remove|destroy)(?:[_-]|$)/i

// Keys whose value names an ad account. We only trust an explicit account field --
// a bare long number elsewhere in the payload (campaign/adset/ad ids are also
// 15-17 digits) must never be mistaken for an account.
const ACCOUNT_KEY = /^(act|account|account_id|ad_account|ad_account_id|acct|acct_id)$/i

// Every account id mentioned anywhere in the payload, normalised (act_123 -> 123).
// Returns { named, anyDigits }: `named` are values under an account-ish key,
// `anyDigits` is every long numeric token seen at all (used to prove the OTHER
// account is not referenced even in a field we do not recognise).
export function collectAccountIds(input) {
  const named = new Set()
  const anyDigits = new Set()
  const norm = (v) => {
    const m = String(v).match(/^(?:act_)?(\d{8,20})$/)
    return m ? m[1] : null
  }
  const walk = (node, key) => {
    if (node == null) return
    if (Array.isArray(node)) { for (const v of node) walk(v, key); return }
    if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, k); return }
    const n = norm(node)
    if (n) {
      anyDigits.add(n)
      if (key && ACCOUNT_KEY.test(key)) named.add(n)
    }
  }
  walk(input, null)
  return { named, anyDigits }
}

// The audit log records what was ATTEMPTED, refusals included -- and a refused call is
// exactly where a hostile or careless payload turns up. So the payload is scrubbed
// before it is written: a log that faithfully copies a credential is a worse leak than
// the call it refused, because the log outlives the attempt.
const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential|cookie|session)/i
const LOG_VALUE_MAX = 300

export function scrubForLog(value, key) {
  if (value == null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubForLog(v, key))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubForLog(v, k)
    return out
  }
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY.test(key)) return '[redacted]'
    return value.length > LOG_VALUE_MAX ? `${value.slice(0, LOG_VALUE_MAX)}…[+${value.length - LOG_VALUE_MAX} chars]` : value
  }
  return value
}

// Does the grant permit this exact call? Returns a reason string on refusal so the
// log says WHY, not just "no".
export function grantAllows(name, sn, { grant, cwd, now, toolInput } = {}) {
  if (!grant || typeof grant !== 'object') return { ok: false, why: 'no grant' }
  const exp = Number(grant.expires_at)
  if (!Number.isFinite(exp)) return { ok: false, why: 'grant has no valid expires_at' }
  if (!(now < exp * 1000)) return { ok: false, why: 'grant expired' }

  // Agent identity comes from the harness-supplied cwd, not from anything the
  // model can write. /Users/macmini/marveen/agents/<name>/...
  const m = String(cwd ?? '').match(/\/agents\/([^/]+)(?:\/|$)/)
  const agent = m ? m[1] : ''
  if (!agent || agent !== grant.agent) return { ok: false, why: `agent "${agent || '?'}" is not the granted agent` }

  // Server must be the granted one specifically -- a Meta grant must never let a
  // Google Ads write through.
  const server = String(grant.server ?? '')
  if (!server) return { ok: false, why: 'grant names no server' }
  if (!new RegExp(`^mcp__${server}[a-z0-9_-]*__`, 'i').test(name)) {
    return { ok: false, why: `tool server is not the granted "${server}"` }
  }

  if (ADS_DESTRUCTIVE.test(sn)) return { ok: false, why: 'destructive op excluded from the grant' }

  const allowed = (Array.isArray(grant.account_ids) ? grant.account_ids : []).map(String)
  if (!allowed.length) return { ok: false, why: 'grant names no account' }

  const { named, anyDigits } = collectAccountIds(toolInput)
  // Fail closed when the account is not stated: an unqualified write could land on
  // whichever account the server treats as default -- possibly the excluded one.
  if (named.size === 0) return { ok: false, why: 'call names no ad account' }
  for (const id of named) if (!allowed.includes(id)) return { ok: false, why: `account ${id} is outside the grant` }
  // Belt and braces: an excluded account must not be referenced anywhere at all.
  for (const bad of (Array.isArray(grant.denied_account_ids) ? grant.denied_account_ids : []).map(String)) {
    if (anyDigits.has(bad)) return { ok: false, why: `payload references excluded account ${bad}` }
  }
  return { ok: true, why: `granted for ${[...named].join(',')}` }
}

export function decide(toolName, ctx = {}) {
  const name = String(toolName ?? '')
  if (!name.startsWith('mcp__')) return 'defer'      // non-MCP: out of scope
  if (CHANNEL_ALLOW.test(name)) return 'allow'        // talk to the operator freely
  const sn = shortName(name)
  if (CANVA.test(name)) return CANVA_GATED.test(sn) ? 'defer' : 'allow' // creative work -> allow; publish/delete -> gate
  // Money-spend ad WRITE (Meta/Google Ads) -> HARD-DENY: no dialog, no chat card,
  // no autonomous spend. The agent proposes via /api/approvals to Nova instead.
  // READ verbs on ad servers do NOT match WRITE_VERB, so reporting still allows.
  if (ADS_SERVER.test(name) && (WRITE_VERB.test(sn) || ADS_WRITE_EXTRA.test(sn))) {
    const g = grantAllows(name, sn, ctx)
    return g.ok ? 'allow-granted' : 'deny'
  }
  if (WRITE_VERB.test(sn)) return 'defer'             // mutation -> keep the prompt
  if (READ_VERB.test(sn)) return 'allow'              // read-only -> no prompt
  return 'defer'                                       // unknown -> fail safe (prompt)
}

function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'read-only / channel MCP tool (mcp-permission-gate)',
    },
  }))
  process.exit(0)
}

function deny() {
  // Hook-level deny: the tool is decided (blocked) here, so NO permission dialog is
  // created and NOTHING is forwarded to the channel/chat. The reason tells the agent
  // to route the money-spend through the fleet approval flow instead.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Money-spend ad write is not run autonomously. Propose it via POST /api/approvals to Nova; a human/Nova executes the approved change. (mcp-permission-gate)',
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
function allowGranted(why) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `ads write allowed by the scoped, time-limited grant (${why}) -- logged (mcp-permission-gate)`,
    },
  }))
  process.exit(0)
}

// Read the grant. Any problem -> null -> the normal deny path. A broken or
// half-written grant file must never widen permissions.
function readGrant() {
  try {
    return JSON.parse(readFileSync(GRANT_FILE, 'utf-8'))
  } catch {
    return null
  }
}

// Append-only audit line. Never throws: an unwritable log must not turn into a
// silently different permission decision -- but note the outcome in the record so
// a missing line is distinguishable from a missing call.
function auditLog(entry) {
  try {
    mkdirSync(dirname(GRANT_LOG), { recursive: true })
    appendFileSync(GRANT_LOG, `${JSON.stringify(entry)}\n`)
  } catch { /* logging must not change the decision */ }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    process.exit(0) // malformed/empty: defer, never crash the tool call
  }
  const name = String(payload?.tool_name ?? '')
  const ctx = {
    grant: readGrant(),
    cwd: payload?.cwd,
    now: Date.now(),
    toolInput: payload?.tool_input,
  }
  const decision = decide(name, ctx)

  // Every ads-write attempt is recorded -- allowed AND refused. A refusal line is
  // as interesting as an allow: it shows what the agent tried to do.
  if (decision === 'allow-granted' || (decision === 'deny' && ADS_SERVER.test(name))) {
    const g = grantAllows(name, shortName(name), ctx)
    auditLog({
      ts: new Date(ctx.now).toISOString(),
      decision: decision === 'allow-granted' ? 'ALLOWED' : 'DENIED',
      agent: (String(ctx.cwd ?? '').match(/\/agents\/([^/]+)(?:\/|$)/) || [])[1] ?? null,
      tool: name,
      reason: g.why,
      tool_input: scrubForLog(ctx.toolInput ?? null),
    })
  }

  if (decision === 'allow-granted') allowGranted(grantAllows(name, shortName(name), ctx).why)
  if (decision === 'allow') allow()
  if (decision === 'deny') deny()
  process.exit(0) // defer
}
