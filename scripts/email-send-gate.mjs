#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// STATED LIMIT (msg 14298): this gate catches the ACCIDENTAL send, not a
// determined evader. Static analysis of arbitrary interpreter code is
// undecidable, so a sub-agent CAN send through interpreter code the patterns
// do not model -- the premise "a sub-agent cannot send outbound" does NOT
// hold against intent, only against accident. The exec-heuristic below covers
// the naive shapes (process-spawn plus a known mailer name in one code
// string) and claims no more. Our sub-agents are not adversaries; if that
// assumption ever changes, this gate is the wrong tool.
//
// Why a hook and not a permissions deny-list: the hook is version- and
// mode-independent, and it can analyze command CONTENT (the Bash send-shape
// heuristics below), which a name/prefix deny rule cannot express.
// CORRECTION (SKIPDENY910, measured 2026-09-10): this comment used to claim
// that --dangerously-skip-permissions BYPASSES the settings.json deny list.
// That is false on every CLI version we measured (2.1.63, 2.1.110, 2.1.267;
// marker-file ground truth, deny arm vs no-deny control, -p AND interactive
// TUI): the deny list IS enforced under the flag, and a tool-name deny is
// enforced by removing the tool from the session entirely. The hook remains
// the primary gate anyway -- future CLI behavior is not a contract, and the
// deny list stays a second, independent layer, not the load-bearing one.
//
// This file is wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, and re-applied on every spawn (respawn-safe).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Bash command patterns that send mail. SUBGATEPOZ822 (2026-08-22): these are
// no longer the primary trigger -- they matched CONTENT anywhere in the
// command string, and the header's old premise ("a sub-agent has no
// legitimate need to invoke these") broke measurably: the developer of the
// mail tooling IS a sub-agent, and the gate blocked the delivery of the
// mail-gate fix three times in one afternoon (commit message, PR body,
// card-comment sqlite write), plus five more content hits across the fleet
// the same day. The primary trigger is now isSendInvocation() below
// (command-position analysis); this list remains ONLY as the conservative
// fallback when a command cannot be tokenized (unbalanced quote) -- on
// unparseable input the gate behaves exactly as before, never weaker.
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

// --- command-position analysis (SUBGATEPOZ822) ------------------------------
// Ported from scripts/hooks/outgoing-copy-gate.py (KAPUHATOKOR822, PR #1042,
// two adversarial rounds): quote-aware tokenization, then the INVOKED program
// of each pipeline/sequence segment decides. A quoted token keeps its
// POSITION, so a quoted provider URL in curl argument position still fires
// (the normal way curl is written), while the same domain inside a quoted -d
// payload stays content (the target pattern is anchored to the token start).
// Wrapper-shell -c strings recurse; interpreter code-string arguments
// (python -c / node -e) are scanned for code-level send calls -- code handed
// to an interpreter IS operation, not content.
// Order-independent heredoc stripping (round 3, msg 14286): the rest of
// the intro line (e.g. a redirect after the marker) is command text and
// is KEPT -- only the body is cut. Without this, marker-first spellings
// leaked the body into command position (FP), and dropping the intro
// would have lost a heredoc-fed real sender (FN).
const HEREDOC_RE = /(<<-?\s*'?(\w+)'?[^\n]*)\n[\s\S]*?\n\2(?=\s|$)/g
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z_0-9]*=/
const SENDER_PROG = /^(sendmail|msmtp|swaks)$/i
const SENDPY = /^send\.py$/i
const PYTHON = /^python3?$/i
const NODEISH = /^(node|tsx|ts-node|deno|bun|npx)$/i
const GRAPHMAIL = /^graph-mail(\.ts|\.js)?$/i
const WRAPPER_SHELL = /^(sh|bash|zsh|dash)$/i
const CURLISH = /^(curl|wget|http)$/i
const RESEND_TARGET = /^(https?:\/\/)?([^/@\s]*\.)?api\.resend\.com(\/|$)/i
const CODE_SEND = /\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b/i
// Naive-shape exec heuristic (msg 14298): process-spawn AND a known mailer
// name together in one interpreter code string. Covers the accidental shapes;
// see the STATED LIMIT in the header for what it deliberately does not claim.
const CODE_EXECISH = /\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(/i
const CODE_SENDER_LIT = /sendmail|msmtp|swaks|send\.py/i
const codeStringSends = (code) => CODE_SEND.test(code) || (CODE_EXECISH.test(code) && CODE_SENDER_LIT.test(code))

// Unquoted newline / backtick / `$(` become segment separators; quoted text is
// untouched (it is content). Tracks quote state by hand -- no shell involved.
export function maskSubshellMarkers(cmd) {
  let out = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
      if (ch === q) q = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '\\' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
    if (ch === '\n' || ch === '`') { out += ';'; continue }
    if (ch === '$' && cmd[i + 1] === '(') { out += ';'; i++; continue }
    out += ch
  }
  return out
}

// Quote-aware tokenizer -> [[token, ...], ...] per segment. Throws on an
// unbalanced quote (the caller falls back to the legacy content patterns).
export function segmentsTokens(cmd) {
  const s = maskSubshellMarkers(cmd.replace(HEREDOC_RE, '$1'))
  const segments = []
  let cur = []
  let tok = ''
  let hasTok = false
  let q = null
  const pushTok = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false } }
  const pushSeg = () => { pushTok(); if (cur.length) { segments.push(cur); cur = [] } }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < s.length) { tok += s[++i]; continue }
      if (ch === q) { q = null; continue }
      tok += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; hasTok = true; continue }
    if (ch === '\\' && i + 1 < s.length) { tok += s[++i]; hasTok = true; continue }
    if (ch === ' ' || ch === '\t') { pushTok(); continue }
    if ('|&;()'.includes(ch)) { pushSeg(); continue }
    tok += ch
    hasTok = true
  }
  if (q) throw new Error('unbalanced quote')
  pushSeg()
  return segments
}

const basename = (t) => t.split('/').pop()

function segmentIsSend(toksIn, depth) {
  let toks = toksIn
  while (toks.length && ENV_ASSIGN.test(toks[0])) toks = toks.slice(1)
  if (!toks.length) return false
  const prog = basename(toks[0])
  const rest = toks.slice(1)
  if (SENDER_PROG.test(prog)) return true
  if (WRAPPER_SHELL.test(prog) && depth < 3) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-c' && rest[i + 1] && isSendInvocation(rest[i + 1], depth + 1)) return true
    }
  }
  if (PYTHON.test(prog) || NODEISH.test(prog)) {
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '-c' || rest[i] === '-e' || rest[i] === '--eval') &&
          rest[i + 1] && codeStringSends(rest[i + 1])) return true
    }
  }
  const candidates = [prog]
  if ((PYTHON.test(prog) || NODEISH.test(prog)) && rest.length) candidates.push(basename(rest[0]))
  if (candidates.some((c) => SENDPY.test(c)) &&
      rest.some((t) => t === '--to' || t.startsWith('--to='))) return true
  if (toks.some((t) => GRAPHMAIL.test(basename(t))) && rest.includes('send')) return true
  if (CURLISH.test(prog) && rest.some((t) => RESEND_TARGET.test(t))) return true
  return false
}

export function isSendInvocation(cmd, depth = 0) {
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch {
    // Unparseable command: fall back to the LEGACY content patterns, so on
    // this path the gate is exactly as strict as before -- never weaker.
    return SEND_PATTERNS.some((re) => re.test(cmd))
  }
  return segments.some((toks) => segmentIsSend(toks, depth))
}

// Outbound-shaped operations of the multiplexed manage_email tool. Each of
// these sends for real unless the call explicitly asks for a draft.
const MANAGE_EMAIL_SEND_OPS = new Set(['send', 'reply', 'replyall', 'forward'])

// Pure decision: does this tool call send (or attempt to send) email?
// Returns { deny, kind? }. `kind` selects the deny wording at the hook
// entrypoint: 'draft-required' is the manage_email case (drafting is fine,
// only the actual send is refused), 'send_email' is the direct MCP send tool
// (the only path the thread-reply capability below can narrow), everything
// else is the sub-agent governance block.
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  if (/send_email/i.test(name)) return { deny: true, kind: 'send_email' }
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
    if (isSendInvocation(cmd)) return { deny: true }
  }
  return { deny: false }
}

// Deny wording for the manage_email case. Unlike the sub-agent governance
// block this is not about who the agent is: drafting stays open, so the fix is
// to re-issue the same call with draft: true and hand the draft to the owner.
export function buildDraftOnlyMsg(ownerName) {
  return (
    'Kimeno email kuldese tiltott (draft-kapu). ' +
    'Ird meg ugyanezt draft: true kapcsoloval, es jelezd a tulajdonosnak ' +
    `(${ownerName}), hogy a Gmail piszkozatok kozott varja a jovahagyasat. ` +
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

// --- thread-scoped reply (BONIMAIL910) --------------------------------------
// Owner decision 2026-09-10: ONE named agent may send outbound email, but ONLY
// into an EXISTING Gmail thread and ONLY to addresses that already appear in
// that thread's headers. The capability is granted per agent in code
// (agent-scaffold.ts appends --allow-thread-reply to this hook's command when
// the agent's capability list contains EMAIL_THREAD_REPLY_CAPABILITY); every
// other agent keeps the unconditional deny above.
//
// Why THREAD-MEMBERSHIP and not a topic rule: the 2026-06-25 incident that
// created this gate was a sub-agent mailing a FABRICATED address in the
// owner's name. Membership in an existing thread is checkable in code; "is
// this financial" is not. The narrowing closes exactly the failure shape that
// created the rule: a new address can never be introduced.
//
// Every branch below fails CLOSED: missing threadId, unparseable recipient,
// empty participant list, credential/fetch/HTTP error, timeout -> deny.

// One address token. Deliberately simple: it must match what appears both in
// the tool input and in Gmail's From/To/Cc header values.
const ADDR_TOKEN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

// Parse one recipient entry ("addr" or "Name <addr>") to a bare lowercase
// address. Returns '' when the entry is not a single clean address -- the
// caller treats that as deny (an unparseable recipient must never slip past
// the membership check).
export function extractAddress(raw) {
  const s = String(raw ?? '').trim()
  const angle = s.match(/<([^<>]+)>$/)
  const cand = (angle ? angle[1] : s).trim()
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(cand) ? cand.toLowerCase() : ''
}

// Validate the send_email tool input as a thread-reply request. Pure.
// Returns { ok: true, threadId, recipients } or { ok: false, reason }.
export function threadReplyRequest(toolInput) {
  const threadId = toolInput?.threadId
  if (typeof threadId !== 'string' || !threadId.trim()) {
    return { ok: false, reason: 'threadId hianyzik (uj szal nyitasa tiltott)' }
  }
  const raw = [toolInput?.to, toolInput?.cc, toolInput?.bcc]
    .flatMap((v) => (Array.isArray(v) ? v : v == null ? [] : [v]))
  if (!raw.length) return { ok: false, reason: 'nincs cimzett' }
  const recipients = []
  for (const r of raw) {
    const addr = extractAddress(r)
    if (!addr) return { ok: false, reason: `ertelmezhetetlen cimzett: ${String(r)}` }
    recipients.push(addr)
  }
  return { ok: true, threadId: threadId.trim(), recipients }
}

// The membership decision itself. Pure. Empty participant list denies: a
// thread we could not read participants from authorizes nothing.
export function threadMembershipDecision(recipients, participants) {
  const set = new Set((participants ?? []).map((p) => String(p).toLowerCase()).filter(Boolean))
  if (!set.size) return { allow: false, reason: 'a szal resztvevo-listaja ures (fail-closed)' }
  for (const r of recipients) {
    if (!set.has(r)) return { allow: false, reason: `cimzett nincs a szalban: ${r}` }
  }
  return { allow: true }
}

// Collect every address that appears in the thread's From/To/Cc/Reply-To
// headers. Pure over the Gmail API thread payload (format=metadata).
export function extractParticipants(threadData) {
  const out = new Set()
  for (const msg of threadData?.messages ?? []) {
    for (const h of msg?.payload?.headers ?? []) {
      const n = String(h?.name ?? '').toLowerCase()
      if (n === 'from' || n === 'to' || n === 'cc' || n === 'reply-to') {
        for (const m of String(h?.value ?? '').matchAll(ADDR_TOKEN)) out.add(m[0].toLowerCase())
      }
    }
  }
  return [...out]
}

// Fetch the thread's participant addresses with the same credentials the Gmail
// MCP server uses (same mailbox the send would go through, so the gate and the
// send see the same thread). Path resolution mirrors the MCP server's own:
// GMAIL_CREDENTIALS_PATH / GMAIL_OAUTH_PATH env overrides, else ~/.gmail-mcp.
// Throws on ANY failure; per-request timeouts keep the whole check well under
// the hook's 10s budget (a hook timeout would be a NON-blocking error, i.e.
// fail-open -- the script must always decide first).
export async function fetchThreadParticipants(threadId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf-8'))
  const now = opts.now ?? (() => Date.now())
  const home = process.env.HOME || homedir()
  const credPath = process.env.GMAIL_CREDENTIALS_PATH || join(home, '.gmail-mcp', 'credentials.json')
  const keysPath = process.env.GMAIL_OAUTH_PATH || join(home, '.gmail-mcp', 'gcp-oauth.keys.json')
  const creds = JSON.parse(readFile(credPath))
  let accessToken = creds.access_token
  const fresh = typeof creds.expiry_date === 'number' && creds.expiry_date > now() + 60_000
  if (!fresh) {
    const keys = JSON.parse(readFile(keysPath))
    const k = keys.installed ?? keys.web
    if (!k?.client_id || !k?.client_secret || !creds.refresh_token) {
      throw new Error('gmail credentials incomplete')
    }
    const res = await fetchImpl(k.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: k.client_id,
        client_secret: k.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(3500),
    })
    if (!res.ok) throw new Error(`token refresh failed: ${res.status}`)
    accessToken = (await res.json())?.access_token
  }
  if (!accessToken) throw new Error('no gmail access token')
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/'
    + encodeURIComponent(threadId)
    + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To'
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(3500),
  })
  if (!res.ok) throw new Error(`thread fetch failed: ${res.status}`)
  return extractParticipants(await res.json())
}

// Deny wording for the thread-reply case: the agent HAS a send right, the
// specific call fell outside it. Says what the right covers and the way out.
export function buildThreadDenyMsg(botName, detail) {
  return (
    'Kimeno email ezzel a jogosultsaggal CSAK meglevo szalba mehet, es csak a ' +
    `szalban mar szereplo cimzettnek (szal-kapu). Elutasitva: ${detail}. ` +
    `Uj cimzetthez vagy uj szalhoz kuldd a tervezett emailt ${botName}nek ` +
    'inter-agent uzenetben jovahagyasra.'
  )
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
    if (kind === 'draft-required') deny(buildDraftOnlyMsg(ownerName))
    // Thread-scoped narrowing: only when the scaffold wired this agent's hook
    // command with the flag (capability-driven, regenerated on every spawn),
    // and only for the direct send_email tool. Bash send routes and
    // manage_email stay fully gated even for the capable agent.
    if (kind === 'send_email' && process.argv.includes('--allow-thread-reply')) {
      const req = threadReplyRequest(payload?.tool_input)
      if (!req.ok) deny(buildThreadDenyMsg(botName, req.reason))
      let verdict
      try {
        const participants = await fetchThreadParticipants(req.threadId)
        verdict = threadMembershipDecision(req.recipients, participants)
      } catch {
        verdict = { allow: false, reason: 'a szal resztvevoi nem olvashatok (fail-closed)' }
      }
      if (verdict.allow) allow()
      deny(buildThreadDenyMsg(botName, verdict.reason))
    }
    deny(buildGateMsg(botName, ownerName))
  }
  allow()
}
