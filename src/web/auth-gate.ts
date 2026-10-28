// Unified auth resolution for the dashboard HTTP gate.
//
// Extracted from the inline gate that used to live in src/web.ts so the
// precedence is unit-testable (auth-gate.test.ts is the fleet-regression
// contract). The BEARER path is checked first and is byte-for-byte unchanged:
// every fleet curl call, notify.sh, the channels auth probe and the federation
// wire endpoints keep working with zero change, whether or not any dashboard
// user exists.
//
// Precedence (first match wins):
//   1. Authorization: Bearer <dashboard token>   -> { kind: 'token', agent? }  (agent = SELF-ASSERTED X-Agent-Id, advisory)
//   1b. Authorization: Bearer <sub-agent token>  -> { kind: 'token', agent, tokenAgent }  (tokenAgent = AUTHENTICATED, agent-tokens.ts)
//   2. Authorization: Bearer <device key>        -> { kind: 'device', device, deviceId }
//   3. SSE pane-stream ?token=<dashboard token>   -> { kind: 'token' }  (path-scoped)
//   4. SSE pane-stream ?token=<device key>        -> { kind: 'device' } (path-scoped)
//   5. Federation inbound token, endpoint-scoped  -> { kind: 'federation', peer }
//   6. mv_session cookie                          -> { kind: 'session', user }
//   7. none of the above                          -> { kind: 'none' }
//
// requiresAuth() is the separate "is this path gated at all" predicate: public
// probes (auth status, login, avatars) return false; everything under /api/ and
// the fleet manifest return true.
//
// Per-agent tokens (AGENT_TOKENS, see agent-tokens.ts for the threat model):
// a sub-agent's own token resolves to the 'token' kind with `tokenAgent` set
// (and `agent` set to the same name, so every reader that only wants the
// caller's NAME keeps working unchanged). gateRequest() then confines it to
// AGENT_TOKEN_ALLOWLIST (an explicit allowlist, not a denylist), schedule
// writes keep their own 403 rule, and AGENT_IDENTITY_BINDINGS bind every
// identity the request asserts to that agent. The shared token (no
// `tokenAgent`) is the main/admin principal and is byte-identical to before.
// Authorization decisions read `tokenAgent`, never `agent`: `agent` can be a
// typed header on the shared-token lane.

import type http from 'node:http'
import { checkBearerToken } from './dashboard-auth.js'
import { identifyFederationCaller } from './federation/config.js'
import { resolveSession } from './auth-sessions.js'
import { resolveDeviceKey, type DeviceKeyScope } from './auth-device-keys.js'
import { OPERATOR_COOKIE_NAME, resolveOperatorSession } from './operator-sessions.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isKnownAgent } from './agent-config.js'
import type { AgentTokenResolver } from './agent-tokens.js'
import { logger } from '../logger.js'
import { getAgentMessage, getApproval, getDb } from '../db.js'
import { readBody, stashPreReadBody, RequestBodyTooLargeError } from './http-helpers.js'
import { readVaultAcl, type VaultAcl } from './vault-acl.js'

export type AuthResult =
  | { kind: 'token'; agent?: string; tokenAgent?: string }
  | { kind: 'device'; device: string; deviceId: number; scope: DeviceKeyScope }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  | { kind: 'none' }

export const SESSION_COOKIE_NAME = 'mv_session'

// Minimal, allocation-light cookie parser. Only the values we look up matter;
// malformed pairs are skipped rather than throwing.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const value = part.slice(eq + 1).trim()
    if (out[name] === undefined) out[name] = value
  }
  return out
}

// Self-asserted caller identity for fleet callers (card 29c8cf33, option A).
//
// The whole fleet shares ONE dashboard token, so a request carries no identity:
// every agent's curl is byte-identical to every other's. This header lets a
// caller SAY which agent it is, and routes may use it to WARN -- never to
// authorize.
//
// Why a claim and not a credential. Measured 2026-09-14 on this install: all
// seven agents run as the same UNIX user (uid 1000), can read each other's
// files (agents/*/ is drwxrwxr-x) and each other's /proc/<pid>/environ, there
// is no vault (store/vault.json absent) and no OS keyring (keychain.ts gates on
// darwin; this host is Linux). Any per-agent secret written to disk or to the
// environment is therefore readable by every other agent, so a per-agent token
// would not be forgery-proof either -- only more expensive, and 119 files carry
// the shared-token idiom. Meanwhile the measured risk is an ACCIDENT, not an
// attack: of 8 destructive memory calls over two days, zero touched another
// agent's row. An accident tells the truth about its own name, which is exactly
// what this header captures. Real enforcement needs OS-level separation
// (one UNIX user per agent); see docs/agens-azonositas-api.md.
//
// Validation mirrors the `from` check on POST /api/messages: the claim must
// name a registered fleet agent, otherwise it is DROPPED. Never a 403 -- the
// header is advisory, and a request that was valid without it stays valid with
// a bad one.
const AGENT_HEADER = 'x-agent-id'
const AGENT_CLAIM_MAX = 64

function resolveAgentClaim(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[AGENT_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return undefined
  // Cap BEFORE the filesystem check: isKnownAgent stats agents/<name>, and an
  // unbounded header would turn every request into a long-path stat.
  const name = sanitizeAgentIdent(value.trim().slice(0, AGENT_CLAIM_MAX))
  if (!name || !isKnownAgent(name)) return undefined
  return name
}

function isSsePaneStream(path: string, method: string): boolean {
  return method === 'GET' && /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)
}

export function isFederationWireEndpoint(path: string, method: string): boolean {
  return (
    (path === '/api/federation/manifest' && method === 'GET') ||
    (path === '/api/federation/inbox' && method === 'POST')
  )
}

// Public (ungated) surfaces. These mirror the old inline exceptions exactly,
// plus the new POST /api/auth/login (public + throttled) so the login form can
// reach the server before a session exists.
export function requiresAuth(path: string, method: string): boolean {
  if (path === '/api/auth/status' && method === 'GET') return false
  if (path === '/api/auth/login' && method === 'POST') return false
  // DASHOPERATOR1005: the operator page signs in with its key here, before any
  // cookie exists. The handler checks the key, the scope and the owner switch.
  if (path === '/api/operator/login' && method === 'POST') return false
  if (method === 'GET' && (path === '/api/marveen/avatar' || path === '/api/marveen/owner-avatar' || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) return false
  if (path === '/.well-known/fleetq' && method === 'GET') return true
  // VIDEOREVIEW1002: <video src> cannot send a bearer header. The stream is
  // authorised by a single-file, short-lived ticket instead, which the handler
  // checks itself (routes/video-review.ts); without a valid ticket it is 403.
  if (path === '/api/video-review/file' && (method === 'GET' || method === 'HEAD')) return false
  return path.startsWith('/api/')
}

export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
  resolveAgentToken?: AgentTokenResolver,
): AuthResult {
  // 1. Bearer header -- unchanged, highest precedence. The optional agent claim
  //    rides along: it never affects WHETHER the request is authenticated, only
  //    what the routes can say about who asked.
  if (checkBearerToken(req.headers.authorization, dashboardToken)) {
    return { kind: 'token', agent: resolveAgentClaim(req) }
  }

  // 1b. A sub-agent's own token (agents/<name>/.dashboard-token). Only after
  //     the shared token failed, so the main lane stays byte-identical. The
  //     X-Agent-Id header is ignored here: the token already says who it is.
  if (resolveAgentToken) {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
    if (m) {
      const agent = resolveAgentToken(m[1]!.trim())
      if (agent) return { kind: 'token', agent, tokenAgent: agent }
    }
  }

  // 2. Bearer device key. Runs only after the dashboard token failed to match,
  //    so the token lane stays byte-identical; resolveDeviceKey's prefix check
  //    makes this a no-op for every non-key bearer (and with zero device_keys
  //    rows the whole step never resolves -- fresh installs unaffected).
  const bearerMatch = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
  if (bearerMatch) {
    const dk = resolveDeviceKey(bearerMatch[1]!.trim())
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id, scope: dk.scope }
  }

  // 3. SSE pane stream ?token= (EventSource cannot set an Authorization header):
  //    dashboard token first, then device key -- a device must be able to open
  //    the pane stream too, or the dashboard would look half-broken on it.
  if (isSsePaneStream(path, method)) {
    const qtoken = url.searchParams.get('token') ?? ''
    if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
    const agent = resolveAgentToken && qtoken ? resolveAgentToken(qtoken) : null
    if (agent) return { kind: 'token', agent, tokenAgent: agent }
    const dk = resolveDeviceKey(qtoken)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id, scope: dk.scope }
  }

  // 4. Scoped per-peer federation tokens: valid ONLY on the two wire endpoints,
  //    and only while federation is enabled (identifyFederationCaller fail-closes).
  if (isFederationWireEndpoint(path, method)) {
    const peer = identifyFederationCaller(req.headers.authorization, checkBearerToken)
    if (peer !== null) return { kind: 'federation', peer }
  }

  // 5. Browser-login session cookie.
  const cookieValue = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
  if (cookieValue) {
    const session = resolveSession(cookieValue)
    if (session) return { kind: 'session', user: session.username }
  }

  // 6. Operator browser session (DASHOPERATOR1005). Resolves to the operator
  //    key it was minted from, so the operator gate fences it exactly like the
  //    key itself; last, so an owner session in the same browser always wins.
  const operatorCookie = parseCookies(req.headers.cookie)[OPERATOR_COOKIE_NAME]
  if (operatorCookie) {
    const op = resolveOperatorSession(operatorCookie)
    if (op) return { kind: 'device', device: op.device, deviceId: op.deviceId, scope: 'operator' }
  }

  return { kind: 'none' }
}

// ---- Sub-agent scope -------------------------------------------------------

// Every method except GET/HEAD on /api/schedules or anything below it counts as
// a schedule write: create (POST), update (PUT/PATCH), delete (DELETE), and the
// POST side-effects (toggle, run-now, pending-retry cancel, the LLM
// expand-* helpers the schedule editor uses). Fail-closed on purpose: a new
// write route added under /api/schedules later is covered without touching
// this list. Matched on a decoded, lower-cased, slash-collapsed copy so no
// spelling variant slips past (the router itself is exact-match, so such
// variants 404 anyway -- this is belt and braces).
export function isScheduleWrite(path: string, method: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false
  let p = path
  try { p = decodeURIComponent(path) } catch { /* keep raw */ }
  p = p.toLowerCase().replace(/\/{2,}/g, '/')
  return p === '/api/schedules' || p.startsWith('/api/schedules/')
}

export function scheduleWriteDeniedMessage(mainAgentId: string): string {
  return `only the main agent writes schedules; send the request to ${mainAgentId} via /api/messages`
}

// ---- Sub-agent ALLOWLIST -----------------------------------------------------
//
// A denylist (schedule writes only) was the first draft, and review broke it
// within a day: POST /api/fleet/import?apply=true writes the scheduled-tasks
// store directly, and POST /api/auth/device-keys, /api/auth/users and
// /api/security/bridge-enroll accept kind 'token' and mint a device or session
// principal that the scope check never sees (credential laundering). A
// denylist is the pattern that never converged for the text gates, so the
// scope is INVERTED: a sub-agent token may call exactly the (method, path)
// pairs below, and everything else on a gated path is 403 (rule
// 'agent-token-scope').
//
// The list is what a sub-agent's generated CLAUDE.md prescribes (messages,
// kanban, memories, daily log, approval request/poll/consume, schedule and
// vault reads) plus the hook endpoints, checked against a 7-day replay of five
// production sub-agents' transcripts (918 dashboard calls, 29 distinct
// method+path pairs): with this list only a self-withdrawn approval (PATCH,
// 1 call) and the schedule writes this guard exists for (7 calls) became 403.
// Deliberately OUT, even where a route merely "works" today: credential/user/
// device/bridge (auth, security), fleet import/export, terminal-input and pane
// keys, settings, agent start/stop/restart, connectors, vault writes/bindings/
// import, memory DELETE, approval resolution (PATCH /api/approvals/:id:
// resolving a level-2 request is the main agent's / owner's lane).
//
// Patterns match the RAW url.pathname, the same string every route handler
// matches with its own anchored regex, so an allowed pattern can only reach the
// handler family it names. HEAD is treated as GET.
export interface AgentAllowEntry {
  methods: readonly string[]
  pattern: RegExp
  why: string
  /** Extra predicate on the match, for what a regex over the RAW path cannot
   *  see (the vault route decodeURIComponent()s its id, so '%73sh-key-x' must
   *  be judged decoded) or what depends on WHICH agent is calling. */
  check?: (m: RegExpExecArray, ctx: { agent: string; vaultAcl: () => VaultAcl }) => boolean
}

// ---- Vault reads by a sub-agent token -----------------------------------------
//
// Which secret a sub-agent token may read is NOT a new table: it is the
// existing per-secret reader allowlist, store/vault-acl.json (vault-acl.ts,
// shape { "<secret-id>": ["agent", ...] }). For a sub-agent TOKEN it always
// binds, whatever VAULT_ACL_MODE says: that switch decides how far a
// self-asserted X-Agent-Id is trusted, and an authenticated principal has
// nothing to switch off. An empty or missing file therefore means "a sub-agent
// token reads no secret value" (the listing, names only, stays open). The main
// token is not affected.

// Vault ids a sub-agent may never read through GET /api/vault/<id>: the vault's
// own sub-resources (bindings, scan, sync, import, resolve) and every SSH id --
// ssh-servers, ssh-keys and the ssh-key-<id> PRIVATE keys the SSH-key manager
// stores as plain vault secrets. Judged on the DECODED, lower-cased id, the
// same string the route hands to getSecret(). A floor under the ACL, should the
// file ever list such an id.
export function isAgentReadableVaultId(rawId: string): boolean {
  let id: string
  try { id = decodeURIComponent(rawId) } catch { return false }
  const lc = id.trim().toLowerCase()
  if (!lc || lc.includes('/')) return false
  if (['bindings', 'scan', 'sync', 'import', 'resolve'].includes(lc)) return false
  if (lc.startsWith('ssh')) return false
  return true
}

/** Both must hold: the id lists the caller in the vault ACL, AND it is not SSH
 *  material or a sub-resource. */
export function isAgentVaultReadAllowed(agent: string, rawId: string, acl: VaultAcl): boolean {
  if (!isAgentReadableVaultId(rawId)) return false
  let id: string
  try { id = decodeURIComponent(rawId) } catch { return false }
  // Own keys only: `acl[id]` on a plain object also finds the prototype, so an
  // id like `__proto__` / `constructor` would reach Object.prototype members.
  const list = Object.prototype.hasOwnProperty.call(acl, id) ? acl[id] : undefined
  return Array.isArray(list) && list.includes(agent)
}

export const AGENT_TOKEN_ALLOWLIST: readonly AgentAllowEntry[] = [
  { methods: ['GET'], pattern: /^\/api\/schedules(?:\/.*)?$/, why: 'read schedules; writes hit the schedule rule' },
  { methods: ['GET', 'POST', 'PUT'], pattern: /^\/api\/messages(?:\/.*)?$/, why: 'inter-agent messages: send (agent-msg.sh), read, write-back PUT /api/messages/:id (message-router contract)' },
  { methods: ['GET'], pattern: /^\/api\/kanban(?:\/.*)?$/, why: 'board and card reads' },
  { methods: ['GET'], pattern: /^\/api\/kanban-projects$/, why: 'board project list (read)' },
  { methods: ['POST'], pattern: /^\/api\/kanban$/, why: 'create card' },
  { methods: ['PUT'], pattern: /^\/api\/kanban\/[^/]+$/, why: 'update card' },
  { methods: ['POST'], pattern: /^\/api\/kanban\/[^/]+\/(?:claim|release|move|comments|archive|unarchive|labels|blockers)$/, why: 'claim/release/move/comment/archive' },
  { methods: ['GET'], pattern: /^\/api\/memories(?:\/.*)?$/, why: 'memory search/read' },
  { methods: ['POST'], pattern: /^\/api\/memories$/, why: 'memory save (PreCompact prompt)' },
  { methods: ['PUT', 'PATCH'], pattern: /^\/api\/memories\/\d+$/, why: 'memory tier move / edit; DELETE stays out' },
  { methods: ['GET'], pattern: /^\/api\/daily-log(?:\/.*)?$/, why: 'daily log read' },
  { methods: ['POST'], pattern: /^\/api\/daily-log$/, why: 'daily log append (PreCompact prompt)' },
  { methods: ['GET'], pattern: /^\/api\/approvals(?:\/[^/]+)?$/, why: 'approval status poll' },
  { methods: ['POST'], pattern: /^\/api\/approvals$/, why: 'request approval (autonomy level 2)' },
  { methods: ['POST'], pattern: /^\/api\/approvals\/[^/]+\/consume$/, why: 'one-shot consume of an approved row (APPROVALCONSUME1022); bound to the caller below' },
  { methods: ['GET'], pattern: /^\/api\/agents$/, why: 'fleet roster' },
  // The listing returns id/label/timestamps only, never a value (routes/connectors.ts listSecrets()).
  { methods: ['GET'], pattern: /^\/api\/vault$/, why: 'vault id list, names only' },
  { methods: ['GET'], pattern: /^\/api\/vault\/([^/]+)$/, check: (m, c) => isAgentVaultReadAllowed(c.agent, m[1]!, c.vaultAcl()), why: 'secret read, ONLY ids store/vault-acl.json lists for the caller' },
  // The route judges every id itself (vaultReadRefused binds a sub-agent token to the ACL in any mode).
  { methods: ['POST'], pattern: /^\/api\/vault\/resolve$/, why: 'batch secret resolve (scripts/vault-resolve.mjs); per id, the ACL decides in the route' },
  { methods: ['GET', 'POST'], pattern: /^\/api\/agent-taskstate\/[^/]+(?:\/replay|\/consume)?$/, why: 'task-state save/replay (PreCompact prompt, taskstate-replay hook)' },
  { methods: ['POST'], pattern: /^\/api\/skill-usage$/, why: 'skill-usage-capture hook' },
  { methods: ['POST'], pattern: /^\/api\/tool-log$/, why: 'tool-log-capture hook' },
  { methods: ['GET'], pattern: /^\/api\/voice\/directive$/, why: 'voice-reply-directive hook' },
]

export function isAgentAllowed(path: string, method: string, agent = '', vaultAcl: () => VaultAcl = readVaultAcl): boolean {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  return AGENT_TOKEN_ALLOWLIST.some((e) => {
    if (!e.methods.includes(m)) return false
    const hit = e.pattern.exec(path)
    return hit !== null && (e.check ? e.check(hit, { agent, vaultAcl }) : true)
  })
}

export function agentScopeDeniedMessage(method: string, path: string, mainAgentId: string): string {
  return `a sub-agent token may not call ${method} ${path} (outside the agent API allowlist); send the request to ${mainAgentId} via /api/messages`
}

export type AgentScopeDenial = { status: 403; body: { error: string; rule: string; agent: string; main_agent: string } }

/**
 * The per-principal scope check that runs right after authentication, on
 * gated paths only. Returns null when the request may proceed, or the 403 to
 * send. Only a sub-agent token (kind 'token' WITH tokenAgent) is ever
 * restricted; the shared/main token (with or without an X-Agent-Id claim),
 * browser sessions, device keys and federation peers are untouched. Order: a
 * schedule write keeps its own, more specific rule; anything else outside the
 * allowlist is 'agent-token-scope'.
 */
export function agentScopeDenial(
  auth: AuthResult,
  path: string,
  method: string,
  mainAgentId: string,
  vaultAcl: () => VaultAcl = readVaultAcl,
): AgentScopeDenial | null {
  if (auth.kind !== 'token' || !auth.tokenAgent) return null
  const base = { agent: auth.tokenAgent, main_agent: mainAgentId }
  if (isScheduleWrite(path, method)) {
    return { status: 403, body: { error: scheduleWriteDeniedMessage(mainAgentId), rule: 'schedule-writes-main-agent-only', ...base } }
  }
  if (isAgentAllowed(path, method, auth.tokenAgent, vaultAcl)) return null
  return { status: 403, body: { error: agentScopeDeniedMessage(method, path, mainAgentId), rule: 'agent-token-scope', ...base } }
}

// ---- Agent identity binding ----------------------------------------------------
//
// Closing the route surface is not enough: the allowlisted routes still trust
// the identity the REQUEST asserts. Review found POST /api/approvals minting a
// row born 'approved' for agent_id=<main> + owner_approved_message_id (approval
// laundering), and the same shape sat in messages 'from', memory rows,
// task-state paths and kanban authorship.
//
// ONE flat invariant, in ONE table: for a sub-agent token, every identity the
// request asserts -- a body field, a path segment, or the owner of the row it
// edits -- must equal tokenAgent, and owner-lane fields are refused. A field
// the handler defaults to the main agent when absent (memories/daily-log
// agent_id) counts as asserting the main agent. Everything else (a missing
// required field, bad JSON) is left to the handler's own 400.
//
// The gate reads the body once for these routes and stashes it for the
// handler (http-helpers stashPreReadBody), so handlers are unchanged. In the
// 918-call replay every body whose identity fields could be recovered already
// named the caller (0 mismatches), so the binding refuses only what a fleet
// never legitimately does.

export interface IdentityLookups {
  /** to_agent of message <id>, or null when the row does not exist. */
  messageRecipient(id: number): string | null
  /** agent_id owning memory <id>, or null when the row does not exist. */
  memoryOwner(id: number): string | null
  /** agent_id that filed approval <id>, or null when the row does not exist. */
  approvalOwner(id: string): string | null
}

export const dbIdentityLookups: IdentityLookups = {
  messageRecipient: (id) => getAgentMessage(id)?.to_agent ?? null,
  approvalOwner: (id) => getApproval(id)?.agent_id ?? null,
  memoryOwner: (id) => {
    const row = getDb().prepare('SELECT agent_id FROM memories WHERE id = ?').get(id) as { agent_id: string } | undefined
    return row?.agent_id ?? null
  },
}

export interface IdentityBinding {
  methods: readonly string[]
  pattern: RegExp
  why: string
  /** Body fields that, when present, must equal the calling agent. */
  bodyFields?: readonly string[]
  /** Body field the handler fills with the MAIN agent when it is absent. */
  defaultsToMain?: string
  /** Owner-lane body fields: refused when present (anything but null/false). */
  ownerLaneFields?: readonly string[]
  /** Capture group holding an agent name in the path (compared decoded). */
  pathAgentGroup?: number
  /** Owner of the row the request edits; must equal the calling agent. */
  rowOwner?: (m: RegExpExecArray, lk: IdentityLookups) => string | null
}

const KANBAN_CARD = '[^/]+'
export const AGENT_IDENTITY_BINDINGS: readonly IdentityBinding[] = [
  { methods: ['POST'], pattern: /^\/api\/approvals$/, bodyFields: ['agent_id'], ownerLaneFields: ['owner_approved_message_id'],
    why: 'a request is filed as the caller; a born-approved row (owner_approved_message_id) is the owner lane' },
  { methods: ['POST'], pattern: /^\/api\/approvals\/([^/]+)\/consume$/, rowOwner: (m, lk) => lk.approvalOwner(m[1]!),
    why: 'a sub-agent consumes only a row it filed itself (and the owner approved), never another agent\'s' },
  { methods: ['POST'], pattern: /^\/api\/messages$/, bodyFields: ['from'], why: 'a message is sent as the caller' },
  { methods: ['PUT'], pattern: /^\/api\/messages\/(\d+)$/, rowOwner: (m, lk) => lk.messageRecipient(Number(m[1])),
    why: 'only a message addressed to the caller can be closed by it' },
  { methods: ['GET', 'POST', 'DELETE'], pattern: /^\/api\/agent-taskstate\/([^/]+)(?:\/replay|\/consume)?$/, pathAgentGroup: 1,
    why: 'task state is per agent; the path names whose' },
  { methods: ['POST'], pattern: /^\/api\/memories$/, bodyFields: ['agent_id'], defaultsToMain: 'agent_id',
    why: 'a memory is saved as the caller (absent agent_id would file it under the main agent)' },
  { methods: ['PUT', 'PATCH'], pattern: /^\/api\/memories\/(\d+)$/, bodyFields: ['agent_id', 'updated_by'],
    rowOwner: (m, lk) => lk.memoryOwner(Number(m[1])),
    why: 'only the caller\'s own memory rows, and never reassigned to another agent' },
  { methods: ['POST'], pattern: /^\/api\/daily-log$/, bodyFields: ['agent_id'], defaultsToMain: 'agent_id',
    why: 'a daily-log entry is written as the caller' },
  { methods: ['POST'], pattern: /^\/api\/kanban$/, bodyFields: ['actor'], why: 'card audit actor is the caller' },
  { methods: ['PUT'], pattern: new RegExp(`^/api/kanban/${KANBAN_CARD}$`), bodyFields: ['actor'], why: 'card audit actor is the caller' },
  { methods: ['POST'], pattern: new RegExp(`^/api/kanban/${KANBAN_CARD}/release$`), bodyFields: ['agent', 'actor'], ownerLaneFields: ['force'],
    why: 'a claim is released by its holder; force is the operator lane' },
  { methods: ['POST'], pattern: new RegExp(`^/api/kanban/${KANBAN_CARD}/claim$`), bodyFields: ['agent', 'actor'], why: 'a claim is taken by the caller' },
  { methods: ['POST'], pattern: new RegExp(`^/api/kanban/${KANBAN_CARD}/move$`), bodyFields: ['actor'], why: 'move actor is the caller' },
  { methods: ['POST'], pattern: new RegExp(`^/api/kanban/${KANBAN_CARD}/comments$`), bodyFields: ['author'], why: 'a comment is authored by the caller' },
  { methods: ['POST'], pattern: new RegExp(`^/api/kanban/${KANBAN_CARD}/(?:archive|unarchive|labels|blockers)$`), bodyFields: ['actor'], why: 'audit actor is the caller' },
  { methods: ['POST'], pattern: /^\/api\/tool-log$/, bodyFields: ['agent_id'], why: 'tool-log rows are written as the caller' },
  { methods: ['POST'], pattern: /^\/api\/skill-usage$/, bodyFields: ['agent_id'], why: 'skill-usage rows are written as the caller' },
]

function matchingBindings(method: string, path: string): Array<{ b: IdentityBinding; m: RegExpExecArray }> {
  const mm = method.toUpperCase()
  const out: Array<{ b: IdentityBinding; m: RegExpExecArray }> = []
  for (const b of AGENT_IDENTITY_BINDINGS) {
    if (!b.methods.includes(mm)) continue
    const m = b.pattern.exec(path)
    if (m) out.push({ b, m })
  }
  return out
}

// A rowOwner binding reads the body FIRST as well: the row lookup then happens
// after the client has finished sending, and the route continues from the
// stashed bytes with no client-timed gap between the check and its write.
export function identityBindingNeedsBody(method: string, path: string): boolean {
  return matchingBindings(method, path).some(({ b }) => !!(b.bodyFields || b.defaultsToMain || b.ownerLaneFields || b.rowOwner))
}

/**
 * The identity check for a sub-agent token. `body` is the parsed JSON body
 * (undefined when absent or unparseable -- the handler answers that).
 * Returns null when every asserted identity is the caller, else a reason.
 */
export function agentIdentityViolation(
  agent: string,
  method: string,
  path: string,
  body: unknown,
  mainAgentId: string,
  lk: IdentityLookups = dbIdentityLookups,
): string | null {
  for (const { b, m } of matchingBindings(method, path)) {
    if (b.pathAgentGroup !== undefined) {
      let named: string
      try { named = decodeURIComponent(m[b.pathAgentGroup] ?? '') } catch { return 'the agent named in the path is not decodable' }
      if (named !== agent) return `the path names agent '${named}', not the calling agent '${agent}'`
    }
    if (b.rowOwner) {
      const owner = b.rowOwner(m, lk)
      // A missing row is REFUSED for a sub-agent token, not deferred to the
      // route's 404: "not yet created" is the pre-arm window of a race (a PUT
      // held open on the NEXT message id until another agent's message lands).
      if (owner === null) return `the row does not exist (yet); a sub-agent token can only act on an existing row of its own`
      if (owner !== agent) return `the row belongs to '${owner}', not to the calling agent '${agent}'`
    }
    if (body !== undefined) {
      const obj = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
      for (const f of b.ownerLaneFields ?? []) {
        const v = obj[f]
        if (v !== undefined && v !== null && v !== false) return `'${f}' is an owner-lane field; a sub-agent token cannot send it`
      }
      for (const f of b.bodyFields ?? []) {
        const v = obj[f]
        if (v === undefined || v === null) continue
        // Exact match: the routes store the value as sent, so ' name ' would
        // pass a trimmed compare and land under a variant id.
        if (typeof v !== 'string' || v !== agent) return `'${f}' must be the calling agent '${agent}', got ${JSON.stringify(v).slice(0, 80)}`
      }
      if (b.defaultsToMain) {
        const v = obj[b.defaultsToMain]
        if (v === undefined || v === null || v === '') return `'${b.defaultsToMain}' is missing, so it would be filed under '${mainAgentId}'; send '${b.defaultsToMain}':'${agent}'`
      }
    }
  }
  return null
}

export function identityDenialBody(agent: string, mainAgentId: string, reason: string): { error: string; rule: string; agent: string; main_agent: string } {
  return {
    error: `identity binding: ${reason}. A sub-agent token acts only as itself; ask ${mainAgentId} via /api/messages for anything else`,
    rule: 'agent-identity-binding',
    agent,
    main_agent: mainAgentId,
  }
}

function writeIdentityDenial(res: http.ServerResponse, agent: string, mainAgentId: string, reason: string, method: string, path: string): void {
  logger.warn({ agent, rule: 'agent-identity-binding', method, path }, 'agent token: identity mismatch refused (403)')
  res.writeHead(403, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(identityDenialBody(agent, mainAgentId, reason)))
}

/**
 * The whole request gate as web.ts runs it: resolve the principal, answer 401
 * for a gated path with no principal (unchanged behaviour), then apply the
 * sub-agent scope (403), then the sub-agent identity binding (403). Returns the
 * principal when the request may proceed, or null once a response has been
 * written. Async because the binding may read the body (stashed for the
 * route). Never throws: a body read failure is answered here. Extracted so the
 * HTTP-level test drives the exact code path the dashboard runs.
 *
 * Without a sub-agent token this is exactly the old inline gate: resolveAuth,
 * then the 401 for a gated path with no principal, nothing else.
 */
export async function gateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  path: string,
  method: string,
  opts: { dashboardToken: string; resolveAgentToken?: AgentTokenResolver; mainAgentId: string; identityLookups?: IdentityLookups; agentVaultAcl?: () => VaultAcl },
): Promise<AuthResult | null> {
  const auth = resolveAuth(req, url, path, method, opts.dashboardToken, opts.resolveAgentToken)
  if (requiresAuth(path, method) && auth.kind === 'none') {
    if (isFederationWireEndpoint(path, method)) {
      // 401s are otherwise silent; federation-endpoint auth failures are the
      // brute-force surface -- make them visible (round-2 scoped-token gate).
      logger.warn({ path, method }, 'federation: rejected wire-endpoint auth')
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return null
  }
  if (auth.kind !== 'token' || !auth.tokenAgent) return auth
  // Public paths (auth status, login, avatars, static assets) stay public for
  // every caller; the scope applies to gated paths only.
  if (!requiresAuth(path, method)) return auth
  const agent = auth.tokenAgent
  const denial = agentScopeDenial(auth, path, method, opts.mainAgentId, opts.agentVaultAcl ?? readVaultAcl)
  if (denial) {
    // The agent NAME is logged, never the token.
    logger.warn({ agent, rule: denial.body.rule, method, path }, 'agent token: request outside the sub-agent scope refused (403)')
    res.writeHead(denial.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(denial.body))
    return null
  }
  if (matchingBindings(method, path).length > 0) {
    let body: unknown
    if (identityBindingNeedsBody(method, path)) {
      let buf: Buffer
      try {
        buf = await readBody(req)
      } catch (err) {
        const tooLarge = err instanceof RequestBodyTooLargeError
        res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: tooLarge ? (err as Error).message : 'request body could not be read' }))
        return null
      }
      stashPreReadBody(req, buf)
      if (buf.length > 0) {
        try { body = JSON.parse(buf.toString()) } catch { body = undefined }
      }
    }
    let reason: string | null
    try {
      reason = agentIdentityViolation(agent, method, path, body, opts.mainAgentId, opts.identityLookups ?? dbIdentityLookups)
    } catch (err) {
      // A lookup failure must not open the door: fail closed.
      logger.error({ err: (err as Error).message, agent, method, path }, 'agent token: identity lookup failed')
      reason = 'the identity could not be verified'
    }
    if (reason) {
      writeIdentityDenial(res, agent, opts.mainAgentId, reason, method, path)
      return null
    }
  }
  return auth
}
