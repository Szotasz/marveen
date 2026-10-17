// Per-agent dashboard tokens.
//
// WHY. Every agent -- the main agent and every sub-agent -- calls the dashboard
// API with the ONE bearer token in store/.dashboard-token, so the server cannot
// tell who is calling. The fleet policy "a sub-agent does not create, modify or
// delete schedules" (self-pace) is enforced only by a text-parsing PreToolUse
// hook (scripts/self-pace-gate.mjs), and a command-line parser cannot see every
// client: a python urllib or node fetch POST to /api/schedules passes it. The
// final guard belongs where the request lands.
//
// WHAT. Each LOCAL sub-agent gets its own random token at
// agents/<name>/.dashboard-token (0600, created idempotently on scaffold and on
// every start). The server maps a presented token to an agent identity:
//
//   store/.dashboard-token         -> main/admin principal (unchanged, can do everything)
//   agents/<name>/.dashboard-token -> sub-agent principal <name> (auth.agent)
//   anything else                  -> 401, exactly as before (fail closed)
//
// What a sub-agent principal may do is decided in auth-gate.ts
// (agentScopeDenial); this module only provisions and resolves the tokens.
//
// THREAT MODEL. Every agent runs as the SAME Unix user as the dashboard, so a
// determined sub-agent can simply read store/.dashboard-token and present the
// main token; file permissions cannot stop that (docs/agens-azonositas-api.md
// measured the same limit). This guards against a sloppy or confused agent --
// one that "finds another way" around a hook -- not a malicious one. The
// self-pace-gate hook stays as defence in depth, and the sub-agent CLAUDE.md
// points at the per-agent file, so the ordinary path an agent takes is the
// scoped one.
//
// ROLLBACK. AGENT_DASHBOARD_TOKENS=0 (process env or .env) turns the feature
// off without breaking a running agent: nothing new is provisioned, the
// generated CLAUDE.md sections and the migration point back at the shared
// file on the next agent start, and an existing per-agent token still
// authenticates, but as the plain shared-token principal (no agent tag, no
// restriction), i.e. exactly the rights every agent had before.
//
// Tokens are never logged. Comparison is timing-safe over fixed-length SHA-256
// digests and scans every entry (no early exit on a hit).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// agents/<name>/ -- the same directory as AGENTS_BASE_DIR in agent-config.ts,
// computed here rather than imported so suites that partially mock
// agent-config.js (several scaffold tests do) keep loading this module.
// Resolved at call time (default parameters), never at module load.
function agentsBaseDir(): string { return join(PROJECT_ROOT, 'agents') }

export const AGENT_TOKEN_FILENAME = '.dashboard-token'
export function mainTokenPath(): string { return join(PROJECT_ROOT, 'store', '.dashboard-token') }

// ---- The on/off switch ------------------------------------------------------
//
// AGENT_DASHBOARD_TOKENS: on unless set to 0 / false / no / off. Read like the
// other rollout flags (message-priority.ts): the process environment first,
// then the .env file, so a changed value needs no rebuild. Cached for a few
// seconds because the auth gate asks on every sub-agent request.
const OFF_VALUES = ['0', 'false', 'no', 'off']
const ENABLED_TTL_MS = 5000
let enabledCache: { value: boolean; at: number } | null = null

export function agentTokensEnabled(now: number = Date.now()): boolean {
  if (enabledCache && now - enabledCache.at < ENABLED_TTL_MS) return enabledCache.value
  let raw = process.env.AGENT_DASHBOARD_TOKENS
  if (raw === undefined || raw.trim() === '') {
    try { raw = readEnvFile(['AGENT_DASHBOARD_TOKENS']).AGENT_DASHBOARD_TOKENS } catch { raw = undefined }
  }
  const value = !OFF_VALUES.includes(String(raw ?? '').trim().toLowerCase())
  enabledCache = { value, at: now }
  return value
}

// A token file shorter than this is treated as absent: an empty or truncated
// file must never become a valid (guessable) credential.
const MIN_TOKEN_LEN = 32
const TOKEN_RE = /^[A-Za-z0-9_-]+$/

// Agent names are directory names produced by sanitizeAgentName; this guard
// keeps a hand-made weird dir (".", "..", a path separator) out of both the
// provisioner and the loader.
function isPlausibleAgentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== MAIN_AGENT_ID
}

export function agentTokenPath(name: string, baseDir: string = agentsBaseDir()): string {
  return join(baseDir, name, AGENT_TOKEN_FILENAME)
}

// The main/admin token's VALUE, read the way loadOrCreateDashboardToken()
// resolves it (DASHBOARD_TOKEN env first, then the store file). Used only to
// refuse an agent token file that is a COPY of it; never logged.
export function readMainTokenValue(): string | null {
  const env = process.env.DASHBOARD_TOKEN?.trim()
  if (env) return env
  try {
    const v = readFileSync(mainTokenPath(), 'utf-8').trim()
    return v || null
  } catch {
    return null
  }
}

type TokenFileState = { token: string } | { token: null; reason: 'absent' | 'not-regular' | 'malformed' | 'equals-main' }

// Read a token file only when it is a REGULAR file (lstat, not stat): a
// symlink to store/.dashboard-token -- the obvious "quick fix" someone might
// make -- must not quietly hand a sub-agent the main credential. A regular
// file whose CONTENT is the main token is the same mistake by copy, and is
// refused the same way: the gate checks the main token first, so such a file
// would silently give the "scoped" agent full rights.
function inspectTokenFile(path: string, mainToken: string | null): TokenFileState {
  let st
  try { st = lstatSync(path) } catch { return { token: null, reason: 'absent' } }
  if (!st.isFile()) return { token: null, reason: 'not-regular' }
  let v: string
  try { v = readFileSync(path, 'utf-8').trim() } catch { return { token: null, reason: 'malformed' } }
  if (v.length < MIN_TOKEN_LEN || !TOKEN_RE.test(v)) return { token: null, reason: 'malformed' }
  if (mainToken && v === mainToken) return { token: null, reason: 'equals-main' }
  return { token: v }
}

function readRegularTokenFile(path: string, mainToken: string | null = readMainTokenValue()): string | null {
  return inspectTokenFile(path, mainToken).token
}

/**
 * Idempotently provision the sub-agent's own token file.
 *
 * - Main agent, implausible name, or missing agent dir -> null (nothing written).
 * - A valid regular token file already exists -> kept as-is; its mode is
 *   tightened to 0600 if it drifted. Returns { created: false }.
 * - Absent, empty, malformed, not a regular file (e.g. a symlink), a copy of
 *   the MAIN token, or the same value another agent's file holds (an agent
 *   directory copied with `cp -r`) -> replaced by a fresh 32-byte hex token
 *   written atomically at 0600. { created: true }.
 *
 * Never logs or returns the token itself. The caller checks
 * agentTokensEnabled() first; this function provisions unconditionally.
 */
export function ensureAgentToken(
  name: string,
  baseDir: string = agentsBaseDir(),
  mainToken: string | null = readMainTokenValue(),
): { path: string; created: boolean } | null {
  if (!isPlausibleAgentName(name)) return null
  const dir = join(baseDir, name)
  if (!existsSync(dir)) return null
  const path = agentTokenPath(name, baseDir)
  const state = inspectTokenFile(path, mainToken)
  if (state.token === null && state.reason === 'equals-main') {
    // Rotate, never keep: this file would hand the agent the admin credential.
    logger.warn({ name, path }, 'agent token: file held a copy of the MAIN token; rotating it to a fresh per-agent token')
  }
  const sharedWith = state.token !== null ? otherHolderOf(state.token, name, baseDir, mainToken) : null
  if (sharedWith !== null) {
    // Two agents holding one value cannot be told apart: the loader refuses
    // both (loadAgentTokens), and this agent gets its own fresh token.
    logger.warn({ name, sharedWith }, 'agent token: file holds the same token as another agent (a copied agent directory?); rotating it')
  }
  if (state.token !== null && sharedWith === null) {
    try {
      if ((lstatSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
    } catch (err) {
      // The token stays valid, but the file may now be looser than 0600: say so.
      logger.warn({ name, path, err: (err as Error).message }, 'agent token: could not tighten file mode to 0600')
    }
    return { path, created: false }
  }
  try {
    // Not a regular file (symlink/dir) or garbage: remove before rewriting so
    // the rename lands on a plain file, never through a link.
    if (existsSync(path) || isDanglingLink(path)) rmSync(path, { recursive: true, force: true })
  } catch { /* the atomic write below will surface a real error */ }
  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 })
  // A fresh token must be accepted on the agent's very first call, not up to
  // one cache TTL later: tell every resolver to re-read on its next lookup.
  invalidateAgentTokenCache()
  return { path, created: true }
}

// The first OTHER agent whose token file holds `token`, or null.
function otherHolderOf(token: string, self: string, baseDir: string, mainToken: string | null): string | null {
  let entries: string[]
  try { entries = readdirSync(baseDir) } catch { return null }
  for (const other of entries) {
    if (other === self || !isPlausibleAgentName(other)) continue
    if (inspectTokenFile(agentTokenPath(other, baseDir), mainToken).token === token) return other
  }
  return null
}

function isDanglingLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/**
 * The token file an agent's generated instructions should `cat`.
 * Main agent -> store/.dashboard-token. A sub-agent -> its own file, but ONLY
 * while the feature is on and that file exists as a valid regular token;
 * otherwise the shared path is returned, so a generated curl never points at a
 * missing file (which would send an empty Bearer and 401 silently).
 */
export function dashboardTokenPathFor(name: string, baseDir: string = agentsBaseDir()): string {
  if (!isPlausibleAgentName(name) || !agentTokensEnabled()) return mainTokenPath()
  const p = agentTokenPath(name, baseDir)
  return readRegularTokenFile(p) !== null ? p : mainTokenPath()
}

// A failing readdir turns EVERY sub-agent call into a bare 401, so it must be
// visible -- but the resolver reloads every few seconds, so say it once a minute.
let lastReaddirWarnAt = 0
// Same for the per-agent "copy of the MAIN token" and "shared value" warnings:
// once a minute per agent (or group), not on every cache reload.
const lastCopyWarnAt = new Map<string, number>()
function warnOncePerMinute(key: string, fields: Record<string, unknown>, msg: string): void {
  const now = Date.now()
  if (now - (lastCopyWarnAt.get(key) ?? 0) < 60_000) return
  lastCopyWarnAt.set(key, now)
  logger.warn(fields, msg)
}

/** Scan <baseDir>/<agent>/.dashboard-token for every plausible sub-agent dir.
 *  Files that are copies of the main token are skipped, and so is every file
 *  whose value another agent holds too (both warned about): such a token
 *  names nobody, so it authenticates nobody. */
export function loadAgentTokens(baseDir: string = agentsBaseDir(), mainToken: string | null = readMainTokenValue()): Map<string, string> {
  const out = new Map<string, string>()
  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  } catch (err) {
    const now = Date.now()
    if (now - lastReaddirWarnAt >= 60_000) {
      lastReaddirWarnAt = now
      logger.warn({ baseDir, err: (err as Error).message }, 'agent tokens: cannot list the agents directory; every sub-agent token will get 401 until this is fixed')
    }
    return out
  }
  for (const name of entries) {
    if (!isPlausibleAgentName(name)) continue
    const state = inspectTokenFile(agentTokenPath(name, baseDir), mainToken)
    if (state.token !== null) out.set(name, state.token)
    else if (state.reason === 'equals-main') {
      warnOncePerMinute(name, { name }, 'agent tokens: agents/<name>/.dashboard-token is a copy of the MAIN token; ignored (restart the agent to rotate it)')
    }
  }
  // A value held by more than one agent (an agents/<x> directory copied to
  // agents/<y>) would authenticate as whichever agent the directory order
  // lists first: fail closed for every holder instead.
  const holders = new Map<string, string[]>()
  for (const [name, tok] of out) holders.set(tok, [...(holders.get(tok) ?? []), name])
  for (const names of holders.values()) {
    if (names.length < 2) continue
    for (const n of names) out.delete(n)
    warnOncePerMinute(`shared:${names.join(',')}`, { agents: names }, 'agent tokens: several agents hold the SAME token; refused for all of them until a restart rotates it')
  }
  return out
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf-8').digest()
}

/**
 * Timing-safe lookup of a presented token among agent tokens. Compares
 * fixed-length SHA-256 digests (no length oracle) and walks every entry even
 * after a hit. Returns the agent name or null.
 */
export function matchAgentToken(provided: string, tokens: ReadonlyMap<string, string>): string | null {
  if (!provided) return null
  const p = digest(provided)
  let hit: string | null = null
  for (const [name, tok] of tokens) {
    if (timingSafeEqual(p, digest(tok)) && hit === null) hit = name
  }
  return hit
}

export type AgentTokenResolver = (provided: string) => string | null

// Bumped whenever a token file is (re)created in this process; every resolver
// reloads on its next lookup when the generation it loaded is stale. Also
// drops the cached on/off switch, so a test (or an operator flipping the
// switch) is seen on the next lookup.
let tokenGeneration = 0
export function invalidateAgentTokenCache(): void {
  tokenGeneration++
  enabledCache = null
}

/**
 * Build the resolver the auth gate uses. The token map is re-read from disk at
 * most every `ttlMs` (default 5 s), so a token provisioned by an agent start or
 * rotated by hand is picked up without a dashboard restart, while an unknown
 * token cannot force a disk scan per request. `mainToken` is the value the
 * dashboard actually serves (web.ts passes it), so a copy of it is refused.
 */
export function createAgentTokenResolver(
  opts: { baseDir?: string; ttlMs?: number; now?: () => number; mainToken?: string | null } = {},
): AgentTokenResolver {
  const baseDir = opts.baseDir ?? agentsBaseDir()
  const ttlMs = opts.ttlMs ?? 5000
  const now = opts.now ?? Date.now
  let cache: Map<string, string> = new Map()
  let loadedAt = -Infinity
  let loadedGeneration = -1
  return (provided: string) => {
    const t = now()
    if (t - loadedAt >= ttlMs || loadedGeneration !== tokenGeneration) {
      cache = loadAgentTokens(baseDir, opts.mainToken === undefined ? readMainTokenValue() : opts.mainToken)
      loadedAt = t
      loadedGeneration = tokenGeneration
    }
    return matchAgentToken(provided, cache)
  }
}

/**
 * Migration for EXISTING sub-agents: rewrite the literal absolute shared-token
 * path in the agent's own CLAUDE.md to its per-agent token path (and back
 * again while AGENT_DASHBOARD_TOKENS is off, so a rollback converges too).
 * Narrow on purpose:
 *   - only the exact absolute shared path is touched, and only where it is NOT
 *     followed by another path character (so `.dashboard-token.bak` or
 *     `.dashboard-token-old` stay as written; the relative form never worked
 *     from agents/<name>/ anyway);
 *   - this agent's OWN per-agent path is also re-anchored when it names
 *     another install root (a host move: ensureProjectRootInClaudeMd only
 *     knows the shared store/ path);
 *   - nothing is rewritten towards the per-agent file until that file exists,
 *     so a failed provisioning never leaves the agent pointing at a missing
 *     file.
 * Idempotent: no write when nothing changes. The generated blocks (autonomy,
 * system-directive, memory-search, ...) are re-rendered right after this with
 * dashboardTokenPathFor(), so they converge to the same path.
 */
export function migrateAgentClaudeMdTokenRefs(
  name: string,
  baseDir: string = agentsBaseDir(),
  mainTokenPathArg: string = mainTokenPath(),
): boolean {
  if (!isPlausibleAgentName(name)) return false
  const perAgent = agentTokenPath(name, baseDir)
  const enabled = agentTokensEnabled()
  if (enabled && readRegularTokenFile(perAgent) === null) return false
  const target = enabled ? perAgent : mainTokenPathArg
  const mdPath = join(baseDir, name, 'CLAUDE.md')
  // Only a REGULAR file is rewritten: a symlinked CLAUDE.md is left alone
  // rather than replaced by a copy, and its mode is carried over below.
  let mode: number
  try {
    const st = lstatSync(mdPath)
    if (!st.isFile()) {
      logger.warn({ name, mdPath }, 'agent token migration: CLAUDE.md is not a regular file; not rewriting it')
      return false
    }
    mode = st.mode & 0o7777
  } catch { return false }
  let existing: string
  try { existing = readFileSync(mdPath, 'utf-8') } catch { return false }
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const notFollowedByPath = '(?![A-Za-z0-9._~/-])'
  // Any absolute root (not `~/`, `{{X}}/` or the tail of a longer path) +
  // agents/<name>/.dashboard-token -- the same root shape the host-move
  // re-anchoring (agent-scaffold.ts FOREIGN_ROOT_RE) accepts.
  const ownAnyRoot = new RegExp(
    `(?<![\\w~}.\\-/])/[^\\s"'\`()<>\\[\\]]*?/${esc(basename(baseDir))}/${esc(name)}/${esc(AGENT_TOKEN_FILENAME)}${notFollowedByPath}`, 'g')
  let updated = existing.replace(ownAnyRoot, () => target)
  if (enabled) updated = updated.replace(new RegExp(`${esc(mainTokenPathArg)}${notFollowedByPath}`, 'g'), () => target)
  if (updated === existing) return false
  atomicWriteFileSync(mdPath, updated, { mode })
  return true
}
