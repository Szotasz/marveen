// Per-agent dashboard tokens (option B of docs/agens-azonositas-api.md).
//
// WHY. Every agent -- the main agent and every sub-agent -- calls the
// dashboard API with the ONE bearer token in store/.dashboard-token, so the
// server cannot tell who is calling; X-Agent-Id (option A) is a self-asserted
// claim. A fleet policy such as "only the main agent creates, modifies or
// deletes schedules" can then only be enforced by text-parsing PreToolUse
// hooks (scripts/self-pace-gate.mjs), and a command-line parser loses that
// race: a sub-agent that uses python urllib instead of curl, `curl -w`, brace
// expansion or a `cd` trick is past it. The final guard belongs where the
// request lands.
//
// WHAT. With AGENT_TOKENS=1 each LOCAL sub-agent gets its own random token at
// agents/<name>/.dashboard-token (0600, created idempotently on scaffold and on
// every start), and its CLAUDE.md is pointed at that file. The server maps a
// presented token to an identity:
//
//   store/.dashboard-token         -> main/admin principal (unchanged, can do everything)
//   agents/<name>/.dashboard-token -> sub-agent principal <name> (auth.tokenAgent)
//   anything else                  -> 401, exactly as before (fail closed)
//
// A sub-agent principal is confined to an explicit ALLOWLIST of (method, path)
// pairs (AGENT_TOKEN_ALLOWLIST in auth-gate.ts), schedule writes get their own
// 403, and every identity the request asserts (from, agent_id, author, ...) is
// bound to the token's agent (AGENT_IDENTITY_BINDINGS).
//
// OFF (the default). Nothing is provisioned and no CLAUDE.md is touched; with
// no token file on disk the resolver never matches, so a shared-token-only
// install behaves exactly as before. Switching it off again: every agent start
// rewrites the agent's CLAUDE.md back to the shared token path
// (revertAgentClaudeMdTokenRefs). A token file that is still on disk keeps
// authenticating as the SCOPED principal until it is deleted, so turning the
// switch off never 401s a running agent; it is never more powerful than the
// shared token.
//
// THREAT MODEL (honest). Every agent runs as the SAME Unix user as the
// dashboard, so a determined sub-agent can simply `cat store/.dashboard-token`
// and present the main token; file permissions cannot stop that. This guards
// against a sloppy or confused agent (one that "finds another way" around a
// hook), not a malicious one. Real enforcement needs one OS user per agent
// (option C of the design doc).
//
// Tokens are never logged. Comparison is timing-safe over fixed-length SHA-256
// digests and scans every entry (no early exit on a hit).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_AGENT_ID, MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// agents/<name>/ -- the same directory as AGENTS_BASE_DIR in agent-config.ts,
// computed here rather than imported so suites that partially mock
// agent-config.js (several scaffold tests do) keep loading this module.
// Resolved at call time (default parameters), never at module load.
function agentsBaseDir(): string { return join(PROJECT_ROOT, 'agents') }

export const AGENT_TOKEN_FILENAME = '.dashboard-token'
export function mainTokenPath(): string { return join(PROJECT_ROOT, 'store', '.dashboard-token') }

/** The AGENT_TOKENS switch (config-registry.ts, default off), read at call
 *  time so the Settings page applies it to the next agent start. A settings
 *  read that throws counts as off: the shared-token behaviour. */
export function agentTokensEnabled(): boolean {
  try {
    return ['1', 'true', 'yes', 'on'].includes(String(getEffectiveSettingValue('AGENT_TOKENS')).trim().toLowerCase())
  } catch {
    return false
  }
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
// refused the same way: the gate checks the main token first,
// so such a file would silently give the "scoped" agent full rights.
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

// Does any OTHER plausible agent dir under baseDir hold this same token value?
// A directory copied with `cp -r` carries its twin's token, and a token held
// by two agents cannot say which one is calling.
function tokenHeldByAnotherAgent(name: string, value: string, baseDir: string, mainToken: string | null): boolean {
  let entries: string[]
  try { entries = readdirSync(baseDir) } catch { return false }
  for (const other of entries) {
    if (other === name || !isPlausibleAgentName(other)) continue
    if (inspectTokenFile(agentTokenPath(other, baseDir), mainToken).token === value) return true
  }
  return false
}

/**
 * Idempotently provision the sub-agent's own token file.
 *
 * - Main agent, implausible name, or missing agent dir -> null (nothing written).
 * - A valid regular token file already exists -> kept as-is; its mode is
 *   tightened to 0600 if it drifted. Returns { created: false }.
 * - Absent, empty, malformed, not a regular file (e.g. a symlink), a copy of
 *   the MAIN token, or a value another agent's file also holds (a directory
 *   copied with cp -r) -> replaced by a fresh 32-byte hex token written
 *   atomically at 0600. { created: true }. Whichever of two twins starts first
 *   is rotated; after that both values are unique again.
 *
 * Never logs or returns the token itself.
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
  // Rotate, never keep, a value another agent's file holds too: the loader
  // authenticates neither while they are equal (loadAgentTokens).
  const duplicated = state.token !== null && tokenHeldByAnotherAgent(name, state.token, baseDir, mainToken)
  if (duplicated) {
    logger.warn({ name, path }, 'agent token: another agent holds the same token (a copied directory?); rotating it to a fresh per-agent token')
  }
  if (state.token !== null && !duplicated) {
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

function isDanglingLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/**
 * The token file an agent's generated instructions should `cat`.
 * Main agent, or AGENT_TOKENS off -> store/.dashboard-token. A sub-agent with
 * the switch on -> its own file, but ONLY once that file exists as a valid
 * regular token; until then the shared path is returned so a generated curl
 * never points at a missing file (which would send an empty Bearer and 401
 * silently).
 */
export function dashboardTokenPathFor(name: string, baseDir: string = agentsBaseDir(), enabled: boolean = agentTokensEnabled()): string {
  if (!enabled || !isPlausibleAgentName(name)) return mainTokenPath()
  const p = agentTokenPath(name, baseDir)
  return readRegularTokenFile(p) !== null ? p : mainTokenPath()
}

// A failing readdir turns EVERY sub-agent call into a bare 401, so it must be
// visible -- but the resolver reloads every few seconds, so say it once a minute.
let lastReaddirWarnAt = 0
// Same for the per-agent "copy of the MAIN token" warning: once a minute
// per agent, not on every cache reload.
const lastCopyWarnAt = new Map<string, number>()
// And for a token value that several agents hold (a copied directory).
const lastDuplicateWarnAt = new Map<string, number>()

/** Scan <baseDir>/<agent>/.dashboard-token for every plausible sub-agent dir.
 *  Files that are copies of the main token are skipped (and warned about).
 *  A value that more than one agent's file holds authenticates NONE of them
 *  (a directory copied with cp -r would otherwise authenticate as its twin);
 *  the next start of either agent rotates its copy (ensureAgentToken). */
export function loadAgentTokens(baseDir: string = agentsBaseDir(), mainToken: string | null = readMainTokenValue()): Map<string, string> {
  const out = new Map<string, string>()
  const byValue = new Map<string, string[]>()
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
    if (state.token !== null) {
      const holders = byValue.get(state.token)
      if (holders) holders.push(name)
      else byValue.set(state.token, [name])
    } else if (state.reason === 'equals-main') {
      const now = Date.now()
      if (now - (lastCopyWarnAt.get(name) ?? 0) >= 60_000) {
        lastCopyWarnAt.set(name, now)
        logger.warn({ name }, 'agent tokens: agents/<name>/.dashboard-token is a copy of the MAIN token; ignored (restart the agent to rotate it)')
      }
    }
  }
  for (const [value, holders] of byValue) {
    if (holders.length === 1) { out.set(holders[0]!, value); continue }
    // Names only, never the value. Once a minute per set of holders.
    const key = holders.slice().sort().join('\0')
    const now = Date.now()
    if (now - (lastDuplicateWarnAt.get(key) ?? 0) >= 60_000) {
      lastDuplicateWarnAt.set(key, now)
      logger.warn({ agents: holders }, 'agent tokens: several agents hold the same token (a copied directory?); it authenticates none of them until the next start rotates it')
    }
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
// reloads on its next lookup when the generation it loaded is stale.
let tokenGeneration = 0
export function invalidateAgentTokenCache(): void { tokenGeneration++ }

/**
 * Build the resolver the auth gate uses. The token map is re-read from disk at
 * most every `ttlMs` (default 5 s), so a token provisioned by an agent start or
 * rotated by hand is picked up without a dashboard restart, while an unknown
 * token cannot force a disk scan per request.
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

// A path character: what may continue a file path. A token path followed by
// one of these is a DIFFERENT file (`.dashboard-token.bak`, `-old`, `/x`) and
// is left as written.
const PATH_CONT = '(?![A-Za-z0-9._~/-])'
// An absolute path prefix, as the host-move re-anchoring (agent-scaffold.ts
// FOREIGN_ROOT_RE) reads one: starts with a `/` that is not the tail of
// something else and never crosses whitespace, quotes, backticks or brackets.
const ABS_PREFIX = '(?<![\\w~}.\\-/])/[^\\s"\'`()<>\\[\\]]*?'
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
// One agent-name path segment (isPlausibleAgentName's shape).
const AGENT_SEG = '[A-Za-z0-9][A-Za-z0-9._-]*'

// Every absolute reference to ANY agent's token file: under the current agents
// dir literally (a root with a space in it is not an ABS_PREFIX match), then
// <any root>/agents/<any agent>/.dashboard-token. An agent's CLAUDE.md has no
// reason to read another agent's token, and after `cp -r anna zara` the copy's
// CLAUDE.md still names anna's file, which resolves to anna.
function anyAgentTokenRefRes(baseDir: string): RegExp[] {
  const file = `/${AGENT_SEG}/${escapeRe(AGENT_TOKEN_FILENAME)}${PATH_CONT}`
  return [
    new RegExp(`${escapeRe(baseDir)}${file}`, 'g'),
    new RegExp(`${ABS_PREFIX}/agents${file}`, 'g'),
  ]
}

// Rewrite a REGULAR CLAUDE.md through `edit`; a symlinked CLAUDE.md is left
// alone rather than replaced by a copy, and the file mode is carried over.
// Idempotent: no write when nothing changes.
function rewriteAgentClaudeMd(name: string, baseDir: string, edit: (text: string) => string): boolean {
  const mdPath = join(baseDir, name, 'CLAUDE.md')
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
  const updated = edit(existing)
  if (updated === existing) return false
  atomicWriteFileSync(mdPath, updated, { mode })
  return true
}

/**
 * Migration for EXISTING sub-agents (AGENT_TOKENS on): rewrite the literal
 * absolute shared-token path in the agent's own CLAUDE.md to its per-agent
 * token path. Narrow on purpose -- only the exact
 * `<PROJECT_ROOT>/store/.dashboard-token` string is touched, and only where it
 * is NOT followed by another path character (the relative form never worked
 * from agents/<name>/ anyway), and only after the per-agent file exists, so a
 * failed provisioning never leaves the agent pointing at a missing file. An
 * absolute reference to ANY agent's token file, under this or another root
 * (a directory copied with cp -r names its twin's file; a moved install names
 * the old root), becomes this agent's own path: an agent's CLAUDE.md has no
 * reason to read another agent's token, and the generic host-move suffix list
 * cannot re-anchor a per-agent path. The generated blocks are
 * re-rendered right after this with dashboardTokenPathFor(), so they converge
 * to the same path.
 */
export function migrateAgentClaudeMdTokenRefs(
  name: string,
  baseDir: string = agentsBaseDir(),
  mainTokenPathArg: string = mainTokenPath(),
): boolean {
  if (!isPlausibleAgentName(name)) return false
  const perAgent = agentTokenPath(name, baseDir)
  if (readRegularTokenFile(perAgent) === null) return false
  const mainRe = new RegExp(`${escapeRe(mainTokenPathArg)}${PATH_CONT}`, 'g')
  return rewriteAgentClaudeMd(name, baseDir, (text) =>
    anyAgentTokenRefRes(baseDir).reduce((t, re) => t.replace(re, () => perAgent), text.replace(mainRe, () => perAgent)))
}

/**
 * The way back (AGENT_TOKENS off): every absolute reference to an agent token
 * file (its own or a twin's, under any root) becomes the shared token path
 * again, so the agent keeps working after its token file is deleted, and a
 * copy made while the switch was on does not keep its twin's path. Idempotent.
 */
export function revertAgentClaudeMdTokenRefs(
  name: string,
  baseDir: string = agentsBaseDir(),
  mainTokenPathArg: string = mainTokenPath(),
): boolean {
  if (!isPlausibleAgentName(name)) return false
  return rewriteAgentClaudeMd(name, baseDir, (text) =>
    anyAgentTokenRefRes(baseDir).reduce((t, re) => t.replace(re, () => mainTokenPathArg), text))
}

/**
 * The agent-start step (agent-process.ts), before the generated CLAUDE.md
 * sections are re-rendered. Switch on: provision the token (idempotent) and
 * point the hand-kept CLAUDE.md body at it. Switch off: point it back at the
 * shared token. The hidden heartbeat worker is skipped: its CLAUDE.md is
 * re-rendered from its own scaffold on every boot.
 */
export function syncAgentTokenOnStart(
  name: string,
  opts: { enabled?: boolean; baseDir?: string; mainTokenPath?: string } = {},
): { provisioned: boolean; rewritten: boolean } {
  if (name === MAIN_AGENT_ID || name === HEARTBEAT_AGENT_ID) return { provisioned: false, rewritten: false }
  const enabled = opts.enabled ?? agentTokensEnabled()
  const baseDir = opts.baseDir ?? agentsBaseDir()
  const mainPath = opts.mainTokenPath ?? mainTokenPath()
  if (!enabled) return { provisioned: false, rewritten: revertAgentClaudeMdTokenRefs(name, baseDir, mainPath) }
  const r = ensureAgentToken(name, baseDir)
  return { provisioned: r?.created ?? false, rewritten: migrateAgentClaudeMdTokenRefs(name, baseDir, mainPath) }
}
