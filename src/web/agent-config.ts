import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { safeJoin } from './sanitize.js'

export const AGENTS_BASE_DIR = join(PROJECT_ROOT, 'agents')

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

// Map short model names to full Claude model IDs (backwards compat with old configs)
export const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-8[1m]',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
  'inherit': DEFAULT_MODEL,
}

export function agentDir(name: string): string {
  // safeJoin rejects path-traversal components. The first line of defense is
  // still sanitizeAgentName() at the create-endpoint, but going through
  // safeJoin turns every non-whitelisted `name` (e.g. a buggy internal caller
  // that forgot to sanitize) into an explicit throw instead of silently
  // writing outside AGENTS_BASE_DIR.
  return safeJoin(AGENTS_BASE_DIR, name)
}

export function agentConfigRoot(name: string): string {
  if (name === MAIN_AGENT_ID) return PROJECT_ROOT
  return agentDir(name)
}

export function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function extractDescriptionFromClaudeMd(content: string): string {
  // Try to grab first meaningful paragraph after any heading
  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  return lines[0]?.trim().slice(0, 200) || ''
}

export function findAvatarForAgent(name: string): string | null {
  const dir = agentDir(name)
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = join(dir, `avatar${ext}`)
    if (existsSync(p)) return p
  }
  return null
}

export function resolveModelId(raw: string): string {
  return MODEL_ALIASES[raw] || raw
}

export function readAgentModel(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    return resolveModelId(config.model || DEFAULT_MODEL)
  } catch {
    return DEFAULT_MODEL
  }
}

export function writeAgentModel(name: string, model: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.model = model
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentDisplayName(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const raw = typeof config.displayName === 'string' ? config.displayName.trim() : ''
    if (raw) return raw
  } catch { /* fall through */ }
  // Fall back to a title-cased version of the sanitized name.
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function writeAgentDisplayName(name: string, displayName: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.displayName = displayName
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentSecurityProfile(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.securityProfile === 'string' && config.securityProfile.trim()) {
      return config.securityProfile.trim()
    }
  } catch { /* fall through */ }
  return 'default'
}

// Pure-logic resolver for the optional per-agent claudeConfigDir field.
// Takes the raw agent-config.json text (or `{}` when no file exists) plus an
// explicit home-dir, and returns the absolute path to use as
// CLAUDE_CONFIG_DIR, or null when the field is missing/blank/non-string or
// the JSON is unparseable. Tilde forms are expanded against the supplied
// homeDir. Kept dependency-free so it can be unit-tested without the fs.
//
// Allowed character set for the path: alphanumerics, dot, slash, hyphen,
// underscore, tilde. Anything else is rejected.
//
// This is a whitelist rather than a blacklist for a reason. The launcher
// inlines the path into a tmux command via nested template literals, which
// produces a shell string with both an outer and an inner double-quoted
// region. Bash treats the inner `"` as a quote delimiter, not a literal,
// so the path actually lands partly inside and partly outside double-quote
// context. Inside double quotes most metachars are tame; outside, almost
// anything (parens, single quote, spaces, semicolons, &, |) is shell-
// significant. Enumerating "safe outside double quotes" by blacklist is a
// trap -- a whitelist of characters that survive both layers is far
// shorter to write and more robust to future changes in the launcher.
//
// Local config is only writable by the host operator, so this is defense-
// in-depth rather than a hard security boundary, but it cheaply removes
// the trivial way to break the launcher with a config typo.
//
// Path values containing `..` segments are also rejected. Without this
// guard `path.join` would silently collapse them ("~/../../../etc/passwd"
// resolves to "/etc/passwd"), which is almost never what the operator
// meant. Absolute paths without `..` remain accepted, so legitimate non-
// home locations like "/var/lib/claude-coding" still work.
const CLAUDE_CONFIG_DIR_ALLOWED = /^[A-Za-z0-9_./~-]+$/

// Only `..` segments are rejected, not `.` (current dir) or empty segments
// from doubled slashes (`//`). Both of those are no-ops -- the OS and
// `path.join` normalize them away without changing where the path points.
// `..` is the only segment that meaningfully alters the destination, so
// it's the only one we treat as suspicious.
function hasParentTraversal(raw: string): boolean {
  return raw.split('/').some(segment => segment === '..')
}

export function resolveClaudeConfigDir(
  rawConfigJson: string,
  homeDir: string,
): string | null {
  let config: unknown
  try { config = JSON.parse(rawConfigJson) } catch { return null }
  if (!config || typeof config !== 'object') return null
  const value = (config as Record<string, unknown>).claudeConfigDir
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(raw)) return null
  if (hasParentTraversal(raw)) return null
  // Tilde may appear at most once, and only as the bare `~` or as the
  // leading `~/` of a `~/...` form. `~user`, mid-string `~`, double tildes
  // -- all rejected because the runtime shell would re-expand them at
  // assignment time even though our resolver does not, and we do not want
  // the launcher to silently route an agent to a different user's home
  // directory or to a path the operator did not write.
  if (raw.includes('~')) {
    const tildeCount = raw.split('~').length - 1
    const validForm = raw === '~' || raw.startsWith('~/')
    if (!validForm || tildeCount > 1) return null
  }
  let resolved: string
  if (raw === '~') resolved = homeDir
  else if (raw.startsWith('~/')) resolved = join(homeDir, raw.slice(2))
  else resolved = raw
  // Re-validate after expansion: if `homeDir` itself contains a character
  // outside the whitelist (e.g. a space in a multi-word account name), the
  // resolved path would land in unquoted shell context and break the
  // launcher cmd. Reject rather than ship a broken export.
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(resolved)) return null
  return resolved
}

// Optional per-agent override for the Claude Code config directory. When set,
// the launcher injects CLAUDE_CONFIG_DIR into the tmux command, letting that
// agent use a different login (credentials, plugins, sessions) than the host
// default. When null, no env var is injected and Claude Code uses its built-in
// default location (`~/.claude/` on macOS/Linux).
export function readAgentClaudeConfigDir(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  return resolveClaudeConfigDir(readFileOr(configPath, '{}'), homedir())
}

// --- Remote agent config (remoteHost + remoteWorkdir) ---
//
// When BOTH a valid host and a valid absolute workdir are present, the agent's
// tmux session runs on a remote machine over ssh instead of locally. Validation
// mirrors resolveClaudeConfigDir's whitelist-not-blacklist philosophy: the host
// is passed as a raw ssh-destination argv element (never shell-interpolated), so
// the charset is defense-in-depth, but the workdir IS inlined into the remote
// launch command (shQuoted), so it is validated strictly too.

// ssh alias or user@host. NO ':' -- `ssh host:port` is not valid syntax; the
// port belongs in the ~/.ssh/config `Port` directive.
const REMOTE_HOST_ALLOWED = /^[A-Za-z0-9_.@-]+$/
// Absolute path only. Tilde is rejected: a `~/proj` workdir would encode to
// `~-proj` for the --continue probe but Claude Code stores the tilde-EXPANDED
// path as `-home-user-proj`, so the probe would never match and --continue would
// be silently dropped. Requiring an absolute path makes the encoding
// deterministic.
const REMOTE_WORKDIR_ALLOWED = /^\/[A-Za-z0-9_./@+-]*$/

export interface RemoteAgentConfig {
  host: string | null
  workdir: string | null
}

// Pure resolver: takes the raw agent-config.json text and returns the remote
// {host, workdir}. An agent is "remote" only when BOTH validate; a
// half-configured agent (host set but workdir invalid, or vice-versa) is
// treated as local (both null) so it never launches into an undefined dir.
export function resolveRemoteConfig(rawConfigJson: string): RemoteAgentConfig {
  const NONE: RemoteAgentConfig = { host: null, workdir: null }
  let config: unknown
  try { config = JSON.parse(rawConfigJson) } catch { return NONE }
  if (!config || typeof config !== 'object') return NONE
  const rawHost = (config as Record<string, unknown>).remoteHost
  const rawWorkdir = (config as Record<string, unknown>).remoteWorkdir
  if (typeof rawHost !== 'string' || typeof rawWorkdir !== 'string') return NONE
  const host = rawHost.trim()
  const workdir = rawWorkdir.trim()
  if (!host || !workdir) return NONE
  if (!REMOTE_HOST_ALLOWED.test(host)) return NONE
  if (!REMOTE_WORKDIR_ALLOWED.test(workdir)) return NONE
  if (hasParentTraversal(workdir)) return NONE
  return { host, workdir }
}

export function readAgentRemoteConfig(name: string): RemoteAgentConfig {
  const configPath = join(agentDir(name), 'agent-config.json')
  return resolveRemoteConfig(readFileOr(configPath, '{}'))
}

// Convenience for the many callers that only need the host to decide whether a
// session is remote. Returns null for local agents.
export function readAgentRemoteHost(name: string): string | null {
  return readAgentRemoteConfig(name).host
}

// Validate-and-persist the remote config. Empty strings clear the fields
// (revert the agent to local). Returns the resolved config on success, or an
// error string when a non-empty value fails validation.
export function writeAgentRemoteConfig(
  name: string,
  host: string,
  workdir: string,
): { ok: true; remote: RemoteAgentConfig } | { ok: false; error: string } {
  const h = host.trim()
  const w = workdir.trim()
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}

  // Clearing: both empty -> remove the fields, agent becomes local.
  if (!h && !w) {
    delete config.remoteHost
    delete config.remoteWorkdir
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
    return { ok: true, remote: { host: null, workdir: null } }
  }

  // Setting: both required and both must validate together.
  if (!h || !w) {
    return { ok: false, error: 'Both remoteHost and remoteWorkdir are required (or both empty to clear).' }
  }
  const probe = resolveRemoteConfig(JSON.stringify({ remoteHost: h, remoteWorkdir: w }))
  if (!probe.host || !probe.workdir) {
    return {
      ok: false,
      error: 'Invalid remoteHost (alias or user@host, no port/metachars) or remoteWorkdir (must be an absolute path without `..`).',
    }
  }
  config.remoteHost = probe.host
  config.remoteWorkdir = probe.workdir
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
  return { ok: true, remote: probe }
}

export function readAgentChannelProvider(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.channelProvider === 'string' && config.channelProvider.trim()) {
      return config.channelProvider.trim()
    }
  } catch { /* fall through */ }
  return null
}

export function writeAgentChannelProvider(name: string, provider: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.channelProvider = provider
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export type AuthMode = 'shared' | 'own_team' | 'api'

const VALID_AUTH_MODES = new Set<AuthMode>(['shared', 'own_team', 'api'])

export function readAgentAuthMode(name: string): AuthMode {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.authMode === 'string' && VALID_AUTH_MODES.has(config.authMode as AuthMode)) {
      return config.authMode as AuthMode
    }
  } catch { /* fall through */ }
  return 'shared'
}

export function writeAgentAuthMode(name: string, mode: AuthMode): void {
  if (!VALID_AUTH_MODES.has(mode)) return
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.authMode = mode
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function writeAgentSecurityProfile(name: string, profileId: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.securityProfile = profileId
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

// Sentinel filename. A subdirectory under agents/ that contains this empty
// file is treated as a TECHNICAL worker, not a first-class agent: it stays
// out of listAgentNames() (so it never appears on the dashboard, in the
// schedule runner, in inter-agent message routing, etc.), but is still a
// real directory on disk for whatever workflow needs it. Used today by
// agents/heartbeat-worker/, the sentinel cwd for the SDK-spawned hourly
// heartbeat sub-agent (Szabi 2026-06-02: "ez a technikai agent meg se
// jelenjen a dashboardon").
export const HIDDEN_AGENT_SENTINEL = '.hidden-from-dashboard'

export function listAgentNames(): string[] {
  if (!existsSync(AGENTS_BASE_DIR)) return []
  return readdirSync(AGENTS_BASE_DIR).filter((f) => {
    try {
      if (!statSync(join(AGENTS_BASE_DIR, f)).isDirectory()) return false
      // Hide technical workers explicitly opted out via the sentinel
      // file. Cheap fs stat -- one extra existsSync per agent dir per
      // tick; the agent list is small (~6 today).
      if (existsSync(join(AGENTS_BASE_DIR, f, HIDDEN_AGENT_SENTINEL))) return false
      return true
    } catch { return false }
  })
}

// Does this identifier refer to a registered agent? MAIN_AGENT_ID always
// counts (it lives outside agents/ but is a first-class peer). Sub-agents
// need a directory on disk. One fs stat per call -- the router calls this
// twice per pending message on its 5s tick, roughly 10-20 stats per tick
// in practice, no memoisation needed.
export function isKnownAgent(name: string): boolean {
  if (!name) return false
  if (name === MAIN_AGENT_ID) return true
  try {
    const dir = agentDir(name)
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}
