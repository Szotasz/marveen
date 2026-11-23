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
//   6b. mv_operator cookie                        -> { kind: 'device', scope: 'operator' }
//   6c. mv_colleague cookie                       -> { kind: 'colleague', colleague, person }  (colleague-sessions.ts)
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
import { resolveDeviceKey, MESSENGER_ORIGIN_NOTE, type DeviceKeyScope } from './auth-device-keys.js'
import { OPERATOR_COOKIE_NAME, resolveOperatorSession } from './operator-sessions.js'
import { COLLEAGUE_COOKIE_NAME, resolveColleagueSession } from './colleague-sessions.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isKnownAgent } from './agent-config.js'
import type { AgentTokenResolver } from './agent-tokens.js'
import { logger } from '../logger.js'
import { countDashboardUsers, getAgentMessage, getApproval, getDb } from '../db.js'
import { SETUP_COOKIE_NAME, isSetupSession } from './public-access.js'
import { readBody, stashPreReadBody, RequestBodyTooLargeError } from './http-helpers.js'
import { OWNER_NAME, VOICE_CHANNEL_ID, DEFAULT_VOICE_CHANNEL_ID } from '../config.js'
import { agentVaultMode, isAgentReadableVaultId, readVaultAcl, type AgentVaultMode, type VaultAcl } from './vault-acl.js'

export type AuthResult =
  | { kind: 'token'; agent?: string; tokenAgent?: string }
  | { kind: 'device'; device: string; deviceId: number; scope: DeviceKeyScope }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  // DOCKERHTTPS1119: a redeemed one-time setup code, on the public listener, while no dashboard user exists. It opens
  // the first-run paths only (routes/auth.ts mayActAsOwnerOrFirstRun); every other owner gate refuses it.
  | { kind: 'setup' }
  // A colleague board login (colleague-sessions.ts). Its own kind on purpose: every owner check trusts 'session', and
  // the colleague gate (colleague-gate.ts) keeps this kind on /api/board and /api/colleague only.
  | { kind: 'colleague'; colleague: string; person: string }
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

// DOCKERHTTPS1119 (Dani 81108 N1): on the public listener a request with NO principal reaches only these
// unauthenticated /api/ paths: the probes and the sign-in steps the page needs before a cookie exists. Every other
// path requiresAuth() leaves open (avatars, the Teams card callback, the operator key login, ...) answers 404 there
// unless a browser cookie came with it, so a future exception in requiresAuth does not reach the internet by itself.
export const PUBLIC_LISTENER_OPEN_PATHS: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/api/auth/status'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/login/totp'],
  ['POST', '/api/auth/setup-code'],
]

// DOCKERHTTPS1119 (Geri's live run 81231, Dani): what a setup session (a redeemed one-time code, before the first
// login) may reach among the gated paths: the wizard's state, so its first step renders, and creating the first
// login. Everything else answers 403 setup_session_scope (403, not 401: a 401 would put the page's access notice
// over the wizard). The owner gates of the routes still decide inside this list.
export const SETUP_SESSION_PATHS: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/api/onboarding/status'],
  ['POST', '/api/auth/users'],
]

export function setupSessionPath(path: string, method: string): boolean {
  return SETUP_SESSION_PATHS.some(([m, p]) => m === method && p === path)
}

export function publicListenerOpenPath(path: string, method: string): boolean {
  return PUBLIC_LISTENER_OPEN_PATHS.some(([m, p]) => m === method && p === path)
}

// Public (ungated) surfaces. These mirror the old inline exceptions exactly,
// plus the new POST /api/auth/login (public + throttled) so the login form can
// reach the server before a session exists.
export function requiresAuth(path: string, method: string): boolean {
  if (path === '/api/auth/status' && method === 'GET') return false
  if (path === '/api/auth/login' && method === 'POST') return false
  // DOCKERHTTPS1119: the second step of the login (the code after the password). Public like the login itself: it is
  // authorised by the pending token the right password returned, and throttled like the login.
  if (path === '/api/auth/login/totp' && method === 'POST') return false
  // DOCKERHTTPS1119: the one-time setup code is redeemed before any cookie exists (public listener only).
  if (path === '/api/auth/setup-code' && method === 'POST') return false
  // DASHOPERATOR1005: the operator page signs in with its key here, before any
  // cookie exists. The handler checks the key, the scope and the owner switch.
  if (path === '/api/operator/login' && method === 'POST') return false
  // The colleague board login (routes/colleague.ts): public like the owner login, throttled, and it only ever mints a
  // colleague session.
  if (path === '/api/colleague/login' && method === 'POST') return false
  if (method === 'GET' && (path === '/api/marveen/avatar' || path === '/api/marveen/owner-avatar' || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) return false
  if (path === '/.well-known/fleetq' && method === 'GET') return true
  // VIDEOREVIEW1002: <video src> cannot send a bearer header. The stream is
  // authorised by a single-file, short-lived ticket instead, which the handler
  // checks itself (routes/video-review.ts); without a valid ticket it is 403.
  if (path === '/api/video-review/file' && (method === 'GET' || method === 'HEAD')) return false
  // TEAMSAPPROVECARD1118: the Teams approval-card click, forwarded by the Teams plugin. It is authorised by the Bot
  // Framework channel token the handler checks itself (bot-channel-token.ts); a dashboard token, shared by every agent,
  // must not count there, so the route takes none. Without a channel token it is 401 (web/approval-teams-card.ts).
  if (path === '/api/approvals/teams-card-action' && method === 'POST') return false
  return path.startsWith('/api/')
}

export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
  resolveAgentToken?: AgentTokenResolver,
  publicListener = false,
): AuthResult {
  // DOCKERHTTPS1119: on the public listener (Caddy's upstream) only browser cookies count. The shared token, a
  // sub-agent's token, a device key, the SSE ?token= and the federation tokens are local credentials: refused
  // there whatever the request carries (public-access.ts says why the listener, not a header, decides).
  if (publicListener) return resolveCookieAuth(req, true)

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
  //    A sub-agent token is NOT accepted here: the pane stream shows another
  //    agent's terminal, and a query-string credential is the one a browser
  //    page holds, never an agent. (In the Bearer header it is outside the
  //    sub-agent scope: 403 agent-token-scope.)
  if (isSsePaneStream(path, method)) {
    const qtoken = url.searchParams.get('token') ?? ''
    if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
    const dk = resolveDeviceKey(qtoken)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id, scope: dk.scope }
  }

  // 4. Scoped per-peer federation tokens: valid ONLY on the two wire endpoints,
  //    and only while federation is enabled (identifyFederationCaller fail-closes).
  if (isFederationWireEndpoint(path, method)) {
    const peer = identifyFederationCaller(req.headers.authorization, checkBearerToken)
    if (peer !== null) return { kind: 'federation', peer }
  }

  return resolveCookieAuth(req, false)
}

/** Steps 5-6 (and, on the public listener, the setup session): the browser cookies. */
function resolveCookieAuth(req: http.IncomingMessage, publicListener: boolean): AuthResult {
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

  // 7. DOCKERHTTPS1119: the setup session, on the public listener only, and only while no dashboard user exists
  //    (disabled ones counted: a login that was ever set up ends the first run for good).
  if (publicListener && isSetupSession(parseCookies(req.headers.cookie)[SETUP_COOKIE_NAME]) && countDashboardUsers(true) === 0) {
    return { kind: 'setup' }
  }

  // 8. Colleague board session. Last, so an owner, operator or setup session in the
  //    same browser always wins; the colleague gate in web.ts then fences this kind.
  const colleagueCookie = parseCookies(req.headers.cookie)[COLLEAGUE_COOKIE_NAME]
  if (colleagueCookie) {
    const c = resolveColleagueSession(colleagueCookie)
    if (c) return { kind: 'colleague', colleague: c.username, person: c.person }
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
// shape { "<secret-id>": ["agent", ...] }). For a sub-agent TOKEN it binds
// whatever VAULT_ACL_MODE says (that switch decides how far a self-asserted
// X-Agent-Id is trusted); the own token has its own switch,
// VAULT_ACL_AGENT_MODE, 'enforce' by default. In 'enforce' an empty or missing
// file means "a sub-agent token reads no secret value" (the listing, names
// only, stays open). 'audit' is the observation week before the list exists:
// the floor below still holds, every other read passes and is logged with the
// allowlist's verdict. The main token is not affected.

// The floor (SSH material, the vault's own sub-resources) lives in vault-acl.ts next to the agent mode; re-exported
// here for the callers and tests that import it from the gate.
export { isAgentReadableVaultId }

/** Both must hold: the id is not SSH material or a sub-resource, AND (in VAULT_ACL_AGENT_MODE=enforce, the default)
 *  the vault ACL lists the caller. In 'audit' (the observation week) the floor alone decides; the route logs the
 *  allowlist's verdict for every such read. */
export function isAgentVaultReadAllowed(agent: string, rawId: string, acl: VaultAcl, agentMode: AgentVaultMode = agentVaultMode()): boolean {
  if (!isAgentReadableVaultId(rawId)) return false
  if (agentMode === 'audit') return true
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
  // The scoped board (board-access.ts). Only an agent board-access.json lists gets past the board gate in web.ts;
  // for such an agent the board gate closes the /api/kanban* entries above.
  { methods: ['GET', 'POST'], pattern: /^\/api\/board\/cards$/, why: 'scoped board: list / create visible cards' },
  { methods: ['GET'], pattern: /^\/api\/board\/cards\/[^/]+$/, why: 'scoped board: read one visible card' },
  { methods: ['POST'], pattern: /^\/api\/board\/cards\/[^/]+\/(?:comments|move)$/, why: 'scoped board: comment on / move a visible card' },
  { methods: ['GET'], pattern: /^\/api\/board\/report$/, why: 'scoped board: daily report' },
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
  // VAULTLOGIN1112: the route checks the entry's allowed_agents against the token's agent; the answer is an outcome only.
  { methods: ['GET'], pattern: /^\/api\/vault\/web-logins$/, why: 'web login list: origins, usernames, allowed agents; never a password' },
  { methods: ['POST'], pattern: /^\/api\/vault\/web-logins\/[a-z0-9-]{1,64}\/login$/, why: 'vault web login in the agent\'s own browser (marveen-api.sh vault-login)' },
  { methods: ['GET', 'POST'], pattern: /^\/api\/agent-taskstate\/[^/]+(?:\/replay|\/consume)?$/, why: 'task-state save/replay (PreCompact prompt, taskstate-replay hook)' },
  { methods: ['POST'], pattern: /^\/api\/skill-usage$/, why: 'skill-usage-capture hook' },
  { methods: ['POST'], pattern: /^\/api\/tool-log$/, why: 'tool-log-capture hook' },
  { methods: ['GET'], pattern: /^\/api\/voice\/directive$/, why: 'voice-reply-directive hook' },
  // VAULTSZELES826 (0) replay, Samu 74563: what sub-agents call today and must keep after AGENT_TOKENS.
  // The proposer is the authenticated token (routes/skills.ts proposedBy = auth.agent); approval stays the owner's.
  { methods: ['POST'], pattern: /^\/api\/skills\/propose$/, why: 'skill proposal (marveen-api.sh skill-propose, every agent CLAUDE.md)' },
  { methods: ['GET'], pattern: /^\/api\/updates$/, why: 'update status (read): version, conflict guard, deployment kind' },
  // AUTOUPDATEDIVERG1110 (Dani F3): read-only, no fetch; an agent reads the hash it files its update_rebase request with.
  { methods: ['GET'], pattern: /^\/api\/updates\/rebase-plan$/, why: 'update rebase plan (read): local commits, upstream, the hash an approval binds' },
  { methods: ['GET'], pattern: /^\/api\/claude-plans\/(?:state|readiness)$/, why: 'plan rotation telemetry and readiness (read); rotation and plan writes stay the main agent\'s' },
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
  /** MVDKSCOPE917: from_agent and to_agent of message <id>, or null when the row does not exist. */
  messageParties(id: number): { from: string; to: string } | null
  /** agent_id owning memory <id>, or null when the row does not exist. */
  memoryOwner(id: number): string | null
  /** The agent that may consume approval <id> with its own token: the row's
   *  for_agent when the main agent granted it to one, else the agent that
   *  filed it; null when the row does not exist. */
  approvalGrantee(id: string): string | null
}

export const dbIdentityLookups: IdentityLookups = {
  messageRecipient: (id) => getAgentMessage(id)?.to_agent ?? null,
  messageParties: (id) => {
    const row = getAgentMessage(id)
    return row ? { from: row.from_agent, to: row.to_agent } : null
  },
  approvalGrantee: (id) => approvalGranteeOf(getApproval(id)),
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
  /** The agent a row is GRANTED to (not necessarily its author); must equal
   *  the calling agent. Missing row, no grant and another agent's grant are
   *  all refused with ONE reason (approvalNotGrantedReason), so the answer
   *  says nothing about whether the id exists. */
  rowGrantee?: (m: RegExpExecArray, lk: IdentityLookups) => string | null
}

/** Who may consume an approval row with a sub-agent token: the grantee the
 *  main agent named (for_agent), else the agent that filed it. One rule,
 *  shared by the gate and the route (routes/approvals.ts). */
export function approvalGranteeOf(row: { agent_id: string; for_agent?: string | null } | null | undefined): string | null {
  if (!row) return null
  return row.for_agent ?? row.agent_id
}

// The single reason for every refused sub-agent consume, shared with the
// route's own repeat of the check (routes/approvals.ts).
export function approvalNotGrantedReason(agent: string): string {
  return `this approval is not granted to the calling agent '${agent}' (it must be the agent's own request, or the main agent must grant it with for_agent)`
}

const KANBAN_CARD = '[^/]+'
export const AGENT_IDENTITY_BINDINGS: readonly IdentityBinding[] = [
  { methods: ['POST'], pattern: /^\/api\/approvals$/, bodyFields: ['agent_id'], ownerLaneFields: ['owner_approved_message_id', 'for_agent'],
    why: 'a request is filed as the caller; a born-approved row (owner_approved_message_id) and a grant to a sub-agent (for_agent) are the owner lane' },
  { methods: ['POST'], pattern: /^\/api\/approvals\/([^/]+)\/consume$/, rowGrantee: (m, lk) => lk.approvalGrantee(m[1]!),
    why: 'a sub-agent consumes only its own request or a row the main agent granted to it (for_agent), never another agent\'s' },
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
  return matchingBindings(method, path).some(({ b }) => !!(b.bodyFields || b.defaultsToMain || b.ownerLaneFields || b.rowOwner || b.rowGrantee))
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
    if (b.rowGrantee) {
      // Read after the body (identityBindingNeedsBody), like rowOwner.
      // agent_id and for_agent are written once at creation and never
      // updated, so no later write can move a grant between this check and
      // the route's consume.
      if (b.rowGrantee(m, lk) !== agent) return approvalNotGrantedReason(agent)
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

// ---- Messenger device key (MVDKSCOPE917) ------------------------------------------
//
// A 'messenger' scoped device key (the voice-robot relay) may send a message as itself to the main agent, marked
// MESSENGER_ORIGIN_NOTE, and read its own conversation. Nothing else, on ANY path (static files and the paths
// requiresAuth leaves open included), so a route added later is closed to it without anyone closing it. Exact
// method (HEAD is not GET), patterns anchored on the RAW url.pathname, and a check on every entry.

/** Fields that change how a row is delivered (urgent, priority, the busy-pane exception, an authorised STOP): a
 *  messenger key sends none of them, whatever the value. */
const MESSENGER_REFUSED_FIELDS = ['urgent', 'priority', 'affects_current_work', 'stop_authorized'] as const

export interface MessengerAllowEntry {
  method: string
  pattern: RegExp
  why: string
  /** The body is read (and stashed for the route) only for an entry that asks for it. */
  needsBody?: boolean
  check: (m: RegExpExecArray, ctx: { device: string; mainAgentId: string; url: URL; body: unknown; lookups: IdentityLookups }) => boolean
}

export const MESSENGER_ALLOWLIST: readonly MessengerAllowEntry[] = [
  {
    method: 'POST', pattern: /^\/api\/messages$/, needsBody: true,
    why: 'send a message as itself, marked hang-robot, to the main agent only, with no delivery-changing field',
    check: (_m, c) => {
      const b = c.body
      if (b === null || typeof b !== 'object' || Array.isArray(b)) return false
      const o = b as Record<string, unknown>
      if (o.from !== c.device) return false
      if (o.origin_note !== MESSENGER_ORIGIN_NOTE) return false
      if (o.to !== c.mainAgentId) return false
      if (typeof o.content !== 'string') return false // the length cap below measures a string (review on #2957)
      return MESSENGER_REFUSED_FIELDS.every((f) => !Object.prototype.hasOwnProperty.call(o, f))
    },
  },
  {
    method: 'GET', pattern: /^\/api\/messages$/,
    why: 'its own conversation: exactly one agent parameter, naming itself (without it the route lists the whole fleet)',
    check: (_m, c) => {
      const agents = c.url.searchParams.getAll('agent')
      return agents.length === 1 && agents[0] === c.device
    },
  },
  {
    method: 'GET', pattern: /^\/api\/messages\/(\d+)$/,
    why: 'one message it sent or that is addressed to it; a missing row is refused',
    check: (m, c) => {
      const parties = c.lookups.messageParties(Number(m[1]))
      return parties !== null && (parties.from === c.device || parties.to === c.device)
    },
  },
]

/** R1 (review on #2957, Samu's decision 81668): a messenger key sends at most this many messages per rolling hour;
 *  more is a 429, so a stolen key, or a TV talking in the robot's room, cannot flood the main agent's queue. Per key
 *  name, in memory (a dashboard restart resets it), counting only POSTs that passed every other check. */
export const MESSENGER_POSTS_PER_HOUR = 3
const MESSENGER_RATE_WINDOW_MS = 3_600_000
/** And at most this many characters (code points) of content per message; longer is a 413 (Samu 81668). */
export const MESSENGER_MAX_CONTENT_CHARS = 500
const messengerPostTimes = new Map<string, number[]>()
/** Tests only: forget every key's window. */
export function resetMessengerRateLimit(): void { messengerPostTimes.clear() }
function messengerPostAllowed(device: string, nowMs: number): boolean {
  const recent = (messengerPostTimes.get(device) ?? []).filter((t) => nowMs - t < MESSENGER_RATE_WINDOW_MS)
  const allowed = recent.length < MESSENGER_POSTS_PER_HOUR
  if (allowed) recent.push(nowMs)
  messengerPostTimes.set(device, recent)
  return allowed
}

/** Why a messenger key's name is unusable, or null. A key named like an agent, the owner, the main agent or the
 *  voice channel id is refused on every request: an agents/<name> directory made later must not turn the key into
 *  that agent. The mint (routes/auth.ts) refuses these names too. */
export function messengerNameTaken(name: string, mainAgentId: string): string | null {
  const id = sanitizeAgentIdent(name)
  if (id === sanitizeAgentIdent(mainAgentId)) return 'the main agent id'
  if (isKnownAgent(id)) return 'a fleet agent'
  if (id === sanitizeAgentIdent(OWNER_NAME)) return "the owner's name"
  if (id === (VOICE_CHANNEL_ID ?? DEFAULT_VOICE_CHANNEL_ID)) return 'the voice channel id'
  return null
}

/** Read the request body once and stash it for the route; null once a 413/400 has been written. */
async function readAndStashBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ buf: Buffer } | null> {
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
  return { buf }
}

function parseJsonOrUndefined(buf: Buffer): unknown {
  if (buf.length === 0) return undefined
  try { return JSON.parse(buf.toString()) } catch { return undefined }
}

function writeMessengerDenial(res: http.ServerResponse, device: string, reason: string, method: string, path: string): void {
  logger.warn({ device, rule: 'device-key-scope', method, path, reason }, 'messenger device key: request refused (403)')
  res.writeHead(403, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: `a messenger device key may not do this: ${reason}`, rule: 'device-key-scope', device }))
}

/** The messenger key's whole scope. Returns true when the request may proceed, false once a response is written. */
async function messengerGate(
  req: http.IncomingMessage, res: http.ServerResponse, url: URL, path: string, method: string,
  device: string, mainAgentId: string, lookups: IdentityLookups,
): Promise<boolean> {
  const taken = messengerNameTaken(device, mainAgentId)
  if (taken) {
    writeMessengerDenial(res, device, `the key is named like ${taken}`, method, path)
    return false
  }
  for (const e of MESSENGER_ALLOWLIST) {
    if (e.method !== method) continue
    const m = e.pattern.exec(path)
    if (!m) continue
    let body: unknown
    if (e.needsBody) {
      const read = await readAndStashBody(req, res)
      if (!read) return false
      body = parseJsonOrUndefined(read.buf)
    }
    let ok: boolean
    try {
      ok = e.check(m, { device, mainAgentId, url, body, lookups })
    } catch (err) {
      // A lookup failure must not open the door: fail closed.
      logger.error({ err: (err as Error).message, device, method, path }, 'messenger device key: check failed')
      ok = false
    }
    // The order is the allowlist (403), then the length (413), then the rate (429): a refused or oversized message
    // never uses up the hour's quota.
    if (ok && e.method === 'POST') {
      const content = (body as Record<string, unknown>).content
      if (typeof content === 'string' && [...content].length > MESSENGER_MAX_CONTENT_CHARS) {
        logger.warn({ device, rule: 'device-key-content-length', method, path }, 'messenger device key: content too long (413)')
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `a messenger device key sends at most ${MESSENGER_MAX_CONTENT_CHARS} characters`, rule: 'device-key-content-length', device }))
        return false
      }
      if (!messengerPostAllowed(device, Date.now())) {
        logger.warn({ device, rule: 'device-key-rate', method, path }, 'messenger device key: rate limit (429)')
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3600' })
        res.end(JSON.stringify({ error: `a messenger device key sends at most ${MESSENGER_POSTS_PER_HOUR} messages an hour`, rule: 'device-key-rate', device }))
        return false
      }
    }
    if (ok) return true
    writeMessengerDenial(res, device, `${method} ${path} outside what the key may send or read (${e.why})`, method, path)
    return false
  }
  writeMessengerDenial(res, device, `${method} ${path} is outside the messenger allowlist`, method, path)
  return false
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
  opts: { dashboardToken: string; resolveAgentToken?: AgentTokenResolver; mainAgentId: string; identityLookups?: IdentityLookups; agentVaultAcl?: () => VaultAcl; publicListener?: boolean },
): Promise<AuthResult | null> {
  const auth = resolveAuth(req, url, path, method, opts.dashboardToken, opts.resolveAgentToken, opts.publicListener === true)
  // Dani n1 (81264): a setup session counts as no principal here too, so it does not reach the self-authenticating
  // public routes (the operator login, avatars, the video file, the Teams card callback) either.
  if (opts.publicListener === true && (auth.kind === 'none' || auth.kind === 'setup') && path.startsWith('/api/') && !requiresAuth(path, method) && !publicListenerOpenPath(path, method)) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return null
  }
  if (auth.kind === 'setup' && requiresAuth(path, method) && !setupSessionPath(path, method)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'The setup code only lets you create the dashboard password. Create it, then sign in.', code: 'setup_session_scope' }))
    return null
  }
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
  // MVDKSCOPE917: a messenger key, on EVERY path (public and static ones included).
  if (auth.kind === 'device' && auth.scope === 'messenger') {
    return (await messengerGate(req, res, url, path, method, auth.device, opts.mainAgentId, opts.identityLookups ?? dbIdentityLookups)) ? auth : null
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
      const read = await readAndStashBody(req, res)
      if (!read) return null
      body = parseJsonOrUndefined(read.buf)
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
