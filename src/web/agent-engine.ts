import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { expandAndValidateConfigDir } from '../config-dir-path.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

export type AgentEngine = 'claude' | 'codex'

// How a Codex agent carries its identity (its workspace trust entry and its MCP
// server) into `codex`:
//  - 'seat' (default): rendered once into <codexConfigDir>/config.toml by
//    renderCodexConfig. Simple, but that file is agent-specific, so one
//    CODEX_HOME ("seat") can host exactly ONE engine agent, and any other tool
//    running `codex exec` on the same seat inherits that agent's MCP identity.
//  - 'overrides': nothing is written into the seat; the same settings travel as
//    `codex -c key=value` argv overrides read from <workspace>/.codex-overrides,
//    so many agents (and unrelated `codex exec` runs) can share one seat.
export type CodexIdentity = 'seat' | 'overrides'

// How much of the host a Codex agent may touch:
//  - 'relay' (default for engine codex): workspace-write sandbox with
//    network_access off. Only the dashboard MCP entry is rendered, replaced by
//    the file-relay MCP shim (scripts/codex-relay/mcp-shim.mjs), which holds no
//    secret. Codex starts this MCP server outside the command sandbox (measured
//    on Codex 0.163.0, Linux); the token stays with the relay daemon. The spool
//    lives under store/, which the relay profile hides from the sandbox.
//    Other inherited MCP servers are dropped.
//  - 'full-access': explicit, owner-only opt-in that REMOVES the sandbox
//    (danger-full-access: the agent can write anywhere the dashboard user can
//    and has the network), never asks for approval, and passes the inherited
//    MCP servers through.
export type CodexSandboxProfile = 'full-access' | 'relay'

export interface AgentEngineConfig { engine: AgentEngine; codexConfigDir: string | null; codexIdentity: CodexIdentity; codexSandbox: CodexSandboxProfile }

export function resolveAgentEngine(value: unknown): AgentEngine {
  if (value === undefined || value === '' || value === 'claude') return 'claude'
  if (value === 'codex') return 'codex'
  throw new Error('engine must be claude or codex')
}

// Resolve the per-agent codexIdentity field. Same shape as resolveAgentEngine:
// absent/blank means the default ('seat'), anything else must be one of the two
// allowed values -- and the field is only meaningful on the codex engine, so a
// value on a claude agent is refused rather than ignored.
export function resolveCodexIdentity(value: unknown, engine: AgentEngine): CodexIdentity {
  // null clears the field (the PUT routes clear with null); an empty string is a value, and an invalid one.
  if (value === undefined || value === null) return 'seat'
  if (engine !== 'codex') throw new Error('codexIdentity is only valid for engine=codex')
  if (value === 'seat' || value === 'overrides') return value
  throw new Error('codexIdentity must be "seat" or "overrides"')
}

// Resolve the per-agent codexSandbox field. Absent/null means the default:
// 'relay' for engine codex, 'full-access' for any other engine (which never
// uses the field, so its resolved config stays unchanged). 'full-access' on
// codex is the explicit opt-in; 'relay' on a non-codex engine is refused. The
// caller that knows the agent name (readAgentEngineConfig) prefixes the message
// with it.
export function resolveCodexSandbox(value: unknown, engine: AgentEngine): CodexSandboxProfile {
  if (value === undefined || value === null) return engine === 'codex' ? 'relay' : 'full-access'
  if (value === 'full-access' || value === 'relay') {
    if (value === 'relay' && engine !== 'codex') throw new Error(`codexSandbox requires engine 'codex'`)
    return value
  }
  throw new Error(`codexSandbox must be 'full-access' or 'relay'`)
}

// The persisted form of an agent-config.json: the DEFAULT identity is not
// written (the resolver would refuse `codexIdentity: "seat"` on a claude agent).
// codexSandbox is dropped for non-codex engines and when it is 'relay' (the
// codex default); 'full-access' on codex is the explicit opt-in and is kept.
export function omitDefaultCodexIdentity(config: AgentEngineConfig | Record<string, unknown>): Record<string, unknown> {
  const persisted: Record<string, unknown> = { ...config }
  if (persisted.codexIdentity === 'seat') delete persisted.codexIdentity
  if (persisted.engine !== 'codex' || persisted.codexSandbox === 'relay') delete persisted.codexSandbox
  return persisted
}

export function resolveCodexConfigDir(raw: unknown): string | null {
  return typeof raw === 'string' && isAbsolute(raw) ? expandAndValidateConfigDir(raw, '') : null
}

export function validateAgentEngine(config: Record<string, unknown>, hasChannel = false): AgentEngineConfig {
  const engine = resolveAgentEngine(config.engine)
  const raw = config.codexConfigDir
  let codexConfigDir: string | null = null
  if (raw !== undefined && raw !== null && raw !== '') {
    if (!resolveCodexConfigDir(raw)) {
      throw new Error('codexConfigDir must be an absolute, shell-safe config directory without parent traversal')
    }
    codexConfigDir = resolveCodexConfigDir(raw)
  }
  if (engine === 'codex') {
    if (!codexConfigDir) throw new Error('codexConfigDir is required for engine=codex')
    const bindings = Object.entries(config).some(([key, value]) =>
      /channel|telegram|teams|slack|discord|googlechat|gromzo/i.test(key) &&
      value !== undefined && value !== null && value !== false && value !== '' &&
      !(Array.isArray(value) && value.length === 0))
    if (hasChannel || bindings) throw new Error('Codex agents cannot own channel bindings')
    if (config.remoteHost || config.runAsUser) throw new Error('Codex pilot agents must run locally as the dashboard user')
  }
  return { engine, codexConfigDir, codexIdentity: resolveCodexIdentity(config.codexIdentity, engine), codexSandbox: resolveCodexSandbox(config.codexSandbox, engine) }
}

export const CHANNEL_SCRUB_VARS = ['TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISCORD_BOT_TOKEN', 'TELEGRAM_STATE_DIR', 'SLACK_STATE_DIR', 'DISCORD_STATE_DIR', 'GOOGLECHAT_STATE_DIR', 'TEAMS_STATE_DIR'] as const
export const CHANNEL_TOKEN_UNSET = `unset ${CHANNEL_SCRUB_VARS.join(' ')}`

/** Options shared by both Codex renderers (and their preflight/scaffold wrappers). */
export interface CodexRenderOptions {
  /** Sandbox profile to render; omitted/'full-access' keeps the historical output. */
  profile?: CodexSandboxProfile
  /** Required by profile 'relay': names the agent in the MCP shim's env. */
  agentName?: string
}

// The one MCP entry the relay profile rewrites: the inherited dashboard server
// carries the agent's dashboard token, and under 'relay' no secret may reach
// the sandbox config, argv or environment. The shim is a plain stdio MCP
// server whose only configuration is the agent name and the relay spool
// directory -- the token stays with the daemon outside the sandbox. Every
// other server entry is dropped under 'relay'; under 'full-access' (or with
// opts omitted) NOTHING is replaced.
const DASHBOARD_MCP_SERVER = 'marveen-dashboard'
export const CODEX_RELAY_PERMISSION_PROFILE = 'marveen-relay'

export function codexRelayDeniedReadRoots(): string[] {
  const lexical = join(PROJECT_ROOT, 'store')
  const roots = [lexical]
  try {
    const physical = realpathSync(lexical)
    if (physical !== lexical) roots.push(physical)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return roots
}

export function codexRelayFilesystemEntries(workspace: string): Array<[string, 'read' | 'write' | 'none']> {
  return [['/', 'read'], [workspace, 'write'], ...codexRelayDeniedReadRoots().map((path): [string, 'none'] => [path, 'none'])]
}
// Read at call time: PROJECT_ROOT may be a lazily mocked getter in tests, which an import-time read would break.
export function relayShimPath(): string {
  return join(PROJECT_ROOT, 'scripts', 'codex-relay', 'mcp-shim.mjs')
}

// Like relayShimPath, resolve PROJECT_ROOT only when called.
export function codexRelayDir(agentName: string): string {
  if (!agentName || agentName === '.' || agentName === '..' || /[/\\\0]/.test(agentName)) {
    throw new Error('relay agent name must be non-empty, not dot or dot-dot, and contain no slash, backslash or NUL')
  }
  return join(PROJECT_ROOT, 'store', 'codex-relay', agentName)
}

function relayServers(servers: Record<string, unknown>, opts: CodexRenderOptions): Record<string, unknown> {
  if (opts.profile !== 'relay') return servers
  const agentName = opts.agentName
  if (typeof agentName !== 'string' || !agentName) {
    throw new Error('relay sandbox profile needs the agent name for the MCP shim entry')
  }
  const relayDir = codexRelayDir(agentName)
  if (!(DASHBOARD_MCP_SERVER in servers)) return {}
  return {
    [DASHBOARD_MCP_SERVER]: {
      command: 'node',
      args: [relayShimPath()],
      env: {
        MARVEEN_AGENT_NAME: agentName,
        MARVEEN_RELAY_DIR: relayDir,
      },
    },
  }
}

/** Names of inherited MCP servers that the relay profile does not render. */
export function relayDroppedMcpServers(servers: Record<string, unknown>, opts: CodexRenderOptions = {}): string[] {
  if (opts.profile !== 'relay') return []
  return Object.keys(servers).filter(name => name !== DASHBOARD_MCP_SERVER).sort()
}

export function renderCodexConfig(workspace: string, servers: Record<string, unknown>, opts: CodexRenderOptions = {}): string {
  const rendered = relayServers(servers, opts)
  // workspace-write has no full-access warning to hide, so under 'relay' the
  // [notice] block is omitted entirely (and the sandbox is nailed to the
  // workspace with the network off).
  const lines = opts.profile === 'relay'
    ? ['sandbox_mode = "workspace-write"', 'approval_policy = "on-request"',
      `default_permissions = ${JSON.stringify(CODEX_RELAY_PERMISSION_PROFILE)}`,
      '', '[sandbox_workspace_write]', 'network_access = false',
      'exclude_slash_tmp = true', 'exclude_tmpdir_env_var = true', '',
      `[permissions.${CODEX_RELAY_PERMISSION_PROFILE}.filesystem]`,
      ...codexRelayFilesystemEntries(workspace).map(([path, access]) => `${JSON.stringify(path)} = ${JSON.stringify(access)}`), '',
      `[projects.${JSON.stringify(workspace)}]`, 'trust_level = "trusted"', '', '[mcp_servers]']
    : ['sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
      '', '[notice]', 'hide_full_access_warning = true', '',
      `[projects.${JSON.stringify(workspace)}]`, 'trust_level = "trusted"', '', '[mcp_servers]']
  for (const [name, raw] of Object.entries(rendered)) {
    const server = raw as { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    if (!server?.command) throw new Error('Codex pilot requires inherited stdio MCP servers')
    lines.push('', `[mcp_servers.${JSON.stringify(name)}]`, `command = ${JSON.stringify(server.command)}`)
    if (server.args) lines.push(`args = ${JSON.stringify(server.args)}`)
    if (server.cwd) lines.push(`cwd = ${JSON.stringify(server.cwd)}`)
    if (server.env) {
      const forwarded = forwardedEnvKeys(server.env)
      for (const key of forwarded) {
        if (withheldFromCodex(key)) throw new Error(`MCP environment variable ${key} is withheld from Codex agents`)
      }
      if (forwarded.length) lines.push(`env_vars = ${JSON.stringify(forwarded)}`)
      const literal = Object.entries(server.env).filter(([key]) => !forwarded.includes(key))
      for (const [key] of literal) {
        if (withheldFromCodex(key)) throw new Error(`MCP environment variable ${key} is withheld from Codex agents`)
        const shimKey = opts.profile === 'relay' && name === DASHBOARD_MCP_SERVER && (key === 'MARVEEN_AGENT_NAME' || key === 'MARVEEN_RELAY_DIR')
        if (!shimKey) {
          throw new Error(`MCP environment variable ${key} of server ${name} would be written into config.toml as a literal value; config.toml takes MCP env values only by reference: set it to \${${key}} (forwarded through env_vars) and provide ${key} in the dashboard's environment`)
        }
      }
      if (literal.length) {
        lines.push(`[mcp_servers.${JSON.stringify(name)}.env]`)
        for (const [key, value] of literal) lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** Env entries whose value is exactly the forwarding sentinel `${KEY}`: codex takes those from its own environment. */
function forwardedEnvKeys(env: Record<string, string>): string[] {
  return Object.entries(env).filter(([key, value]) => value === '${' + key + '}').map(([key]) => key)
}

// A dotted `-c` key is split on '.', so a segment carrying a '.' cannot be
// expressed at all -- which is why the workspace path (and every server / env
// name) is restricted instead of escaped.
const CODEX_OVERRIDE_SEGMENT_ALLOWED = /^[A-Za-z0-9_-]+$/
// The workspace becomes part of the key (`projects.<workspace>.trust_level`):
// '.' would split it, quotes would break the key=value line, and whitespace (a
// newline included) would break the one-override-per-line file the launcher reads.
// R1 review: '=' would end the key (codex splits key=value at the first '='), so the
// workspace is held to an allow-list instead of a deny-list.
const CODEX_OVERRIDE_WORKSPACE_ALLOWED = /^\/[A-Za-z0-9_\/-]+$/
// R1 review: a literal value lands on argv (world-readable /proc/<pid>/cmdline), so a
// withheld name or a credential-shaped name is refused as a literal too; a *_PATH,
// *_FILE, *_DIR or *_URL name carries a location, not the secret itself.
const CODEX_OVERRIDE_SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH|COOKIE|PRIVATE)/i
const CODEX_OVERRIDE_LOCATION_NAME = /_(PATH|FILE|DIR|URL)$/i
function withheldFromCodex(key: string): boolean {
  return /^(CLAUDE|ANTHROPIC)/.test(key) || CHANNEL_SCRUB_VARS.some(scrub => scrub === key)
}

/**
 * codexIdentity='overrides': the SAME settings renderCodexConfig writes into the
 * seat's config.toml, expressed as `codex -c key=value` overrides (value side is
 * valid TOML, strings via JSON.stringify). Relay resolves store/ at call time.
 * Neither renderer expands `${VAR}`; here the result also lands on argv
 * (visible in `ps`), so only env_vars forwarding is allowed for secrets.
 */
export function renderCodexOverrides(workspace: string, servers: Record<string, unknown>, opts: CodexRenderOptions = {}): string[] {
  if (!isAbsolute(workspace) || !CODEX_OVERRIDE_WORKSPACE_ALLOWED.test(workspace)) {
    throw new Error(`codexIdentity=overrides needs an absolute workspace path of letters, digits, '_', '-' and '/' only (no '.', quotes, '=' or whitespace): ${JSON.stringify(workspace)}`)
  }
  const rendered = relayServers(servers, opts)
  const entries = opts.profile === 'relay' ? codexRelayFilesystemEntries(workspace) : []
  if (entries.some(([path]) => path.includes('\n') || path.includes('\0'))) {
    throw new Error('relay filesystem entry path must not contain a newline or NUL')
  }
  // Same settings as the relay branch of renderCodexConfig, in -c form; no
  // notice.hide_full_access_warning line (there is no warning to hide).
  const overrides = opts.profile === 'relay'
    ? [
      'sandbox_mode="workspace-write"',
      'approval_policy="on-request"',
      `default_permissions=${JSON.stringify(CODEX_RELAY_PERMISSION_PROFILE)}`,
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      `permissions.${CODEX_RELAY_PERMISSION_PROFILE}.filesystem={${entries.map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',')}}`,
      `projects.${workspace}.trust_level="trusted"`,
    ]
    : [
      'sandbox_mode="danger-full-access"',
      'approval_policy="never"',
      'notice.hide_full_access_warning=true',
      `projects.${workspace}.trust_level="trusted"`,
    ]
  for (const [name, raw] of Object.entries(rendered)) {
    if (!CODEX_OVERRIDE_SEGMENT_ALLOWED.test(name)) {
      throw new Error(`MCP server name ${JSON.stringify(name)} cannot be expressed as a Codex -c override`)
    }
    const server = raw as { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    if (typeof server?.command !== 'string' || !server.command) throw new Error('Codex pilot requires inherited stdio MCP servers')
    overrides.push(`mcp_servers.${name}.command=${JSON.stringify(server.command)}`)
    if (server.args) overrides.push(`mcp_servers.${name}.args=${JSON.stringify(server.args)}`)
    if (server.cwd) overrides.push(`mcp_servers.${name}.cwd=${JSON.stringify(server.cwd)}`)
    if (server.env) {
      for (const key of Object.keys(server.env)) {
        if (!CODEX_OVERRIDE_SEGMENT_ALLOWED.test(key)) {
          throw new Error(`MCP environment variable name ${JSON.stringify(key)} cannot be expressed as a Codex -c override`)
        }
      }
      const forwarded = forwardedEnvKeys(server.env)
      for (const key of forwarded) {
        if (withheldFromCodex(key)) {
          throw new Error(`MCP environment variable ${key} is withheld from Codex agents`)
        }
      }
      if (forwarded.length) overrides.push(`mcp_servers.${name}.env_vars=${JSON.stringify(forwarded)}`)
      const literal = Object.entries(server.env).filter(([key]) => !forwarded.includes(key))
      for (const [key, value] of literal) {
        if (typeof value !== 'string') throw new Error(`MCP environment variable ${key} must have a string value`)
        if (withheldFromCodex(key)) throw new Error(`MCP environment variable ${key} is withheld from Codex agents`)
        if (CODEX_OVERRIDE_SECRET_NAME.test(key) && !CODEX_OVERRIDE_LOCATION_NAME.test(key)) {
          throw new Error(`MCP environment variable ${key} looks like a credential and would land on argv with codexIdentity=overrides; forward it via env_vars instead`)
        }
        if (value.includes('${')) {
          throw new Error(`MCP environment variable ${key} cannot use \${...} expansion with codexIdentity=overrides; forward it via env_vars instead`)
        }
        if (value.includes('\n') || value.includes('\0')) {
          throw new Error(`MCP environment variable ${key} must not contain a newline or NUL`)
        }
        overrides.push(`mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`)
      }
    }
  }
  return overrides
}

// R2-1 review (fix 7): the dashboard entry's table header has TWO spellings --
// the renderer's quoted key and a hand-written bare key -- and a config.toml
// may contain either or both, so both markers are scanned, at every position.
const DASHBOARD_ENTRY_MARKERS = ['[mcp_servers."marveen-dashboard"', '[mcp_servers.marveen-dashboard'] as const
// An assignment line is `key = value`, where the key may be bare,
// basic-quoted ("...") or literal-quoted ('...'); a comment line is not an
// assignment, whatever it mentions.
const DASHBOARD_ENTRY_ASSIGNMENT = /^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/

// Cut a line at a TOML comment ('#' outside a string): what follows a value is
// prose, never configuration, so a shim path mentioned only in a comment (a
// full-line or a trailing one) must not make a section look safe.
function stripTomlComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = ''
    } else if (quote === "'") {
      if (ch === "'") quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * codexSandbox=relay must refuse a seat config.toml left over from an earlier
 * full-access life of the same agent. Both renderers keep an existing
 * config.toml (preflight returns early, scaffold never rewrites), so an
 * operator switching an agent to 'relay' would otherwise silently keep
 * sandbox_mode = "danger-full-access" and/or a marveen-dashboard MCP entry
 * whose env carries the dashboard token -- the exact containment the relay
 * profile promises would never happen. No-op unless the profile is 'relay' or
 * the file is absent, so the default profile is untouched.
 */
export function assertCodexSeatConfigCompatible(home: string, workspace: string, identity: CodexIdentity, opts: CodexRenderOptions = {}): void {
  if (opts.profile !== 'relay') return
  const configPath = join(home, 'config.toml')
  const refuseSeatConfig = (reason: string): never => {
    throw new Error(
      `codexSandbox=relay refuses the existing ${configPath}: ${reason}. Delete the file and start the agent so it is re-rendered`)
  }
  if (identity === 'seat' && !opts.agentName) refuseSeatConfig('the relay seat needs the agent name')
  const relayDir = identity === 'seat' ? codexRelayDir(opts.agentName!) : undefined
  let content: string
  try {
    content = readFileSync(configPath, 'utf-8')
  } catch (err) {
    // existsSync said yes a moment ago: the file vanished underneath us. An
    // absent file is the no-op case above; anything else is a real read error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  // F4: measured on Codex 0.163.0, Linux: -c filesystem tables merge with
  // the seat's permissions tables, so overrides cannot remove extra grants.
  if (identity === 'overrides') {
    const mergeReason = "the relay profile table would be merged with this file's permissions settings"
    if (content.includes('\\')) {
      refuseSeatConfig(`it contains a backslash (a TOML escape), which this check cannot decode; ${mergeReason}`)
    }
    let tableSeen = false
    for (const rawLine of content.split('\n')) {
      const line = stripTomlComment(rawLine).trim()
      if (!line) continue
      if (line.startsWith('[')) tableSeen = true
      if (line.includes('permissions') && !(!tableSeen && /^default_permissions\s*=/.test(line))) {
        refuseSeatConfig(mergeReason)
      }
    }
  }
  if (identity === 'seat' && content.includes('danger-full-access')) {
    throw new Error(
      `codexSandbox=relay refuses the existing ${configPath}: it still contains 'danger-full-access' from an earlier full-access profile. ` +
      `Remove or re-render ${configPath} for this agent (delete the file and start the agent, so the relay profile can seed the workspace-write sandbox)`)
  }
  for (const marker of DASHBOARD_ENTRY_MARKERS) {
    let markerAt = content.indexOf(marker)
    while (markerAt !== -1) {
      // Only a header the marker itself closes names the entry's table; a
      // longer key (the renderer's [mcp_servers."marveen-dashboard".env]
      // subsection, a similarly named sibling server) is not this entry. The
      // check spans the rest of the header LINE -- from the marker to the next
      // newline (or end of file), so it cannot run onto a later line -- and
      // allows any number of spaces/tabs (and a CRLF carriage return) before
      // ']', however many.
      const lineEnd = content.indexOf('\n', markerAt + marker.length)
      const headerRest = content.slice(markerAt + marker.length, lineEnd === -1 ? undefined : lineEnd)
      if (!/^[ \t\r]*\]/.test(headerRest)) {
        markerAt = content.indexOf(marker, markerAt + 1)
        continue
      }
      // The section runs from its header to the next line starting with '['
      // (a following [mcp_servers] or subsection header) or end of file, and
      // it is acceptable only when at least one ASSIGNMENT line carries
      // mcp-shim.mjs -- a mention inside a comment does not count. Applies to
      // BOTH identity modes: overrides mode never rewrites config.toml
      // either, and the stale entry would still start a token-holding MCP
      // process outside the command sandbox.
      const nextHeader = content.indexOf('\n[', markerAt + 1)
      const section = content.slice(markerAt, nextHeader === -1 ? undefined : nextHeader)
      const shimAssignment = section.split('\n').some(line => DASHBOARD_ENTRY_ASSIGNMENT.test(line) && stripTomlComment(line).includes('mcp-shim.mjs'))
      if (!shimAssignment) {
        throw new Error(
          `codexSandbox=relay refuses the existing ${configPath}: its ${marker}...] entry does not use mcp-shim.mjs, and a non-shim marveen-dashboard entry can carry the dashboard token into the sandbox. ` +
          `Replace it with the shim entry (delete the file and start the agent to re-render it) or remove it`)
      }
      markerAt = content.indexOf(marker, markerAt + 1)
    }
  }
  const allowedHeaders = ['[mcp_servers]', '[mcp_servers."marveen-dashboard"]', '[mcp_servers.marveen-dashboard]', '[mcp_servers."marveen-dashboard".env]', '[mcp_servers.marveen-dashboard.env]']
  let currentKey = ''
  let dashboardSeen = false
  let commandSeen = false
  let argsSeen = false
  const argsLine = `args = ${JSON.stringify([relayShimPath()])}`
  const refuseShimEntry = (line: string): never => {
    throw new Error(
      `codexSandbox=relay refuses the existing ${configPath}: its marveen-dashboard entry is not the relay shim entry (${line}); under relay only command = "node" with args = [the dashboard's mcp-shim.mjs] and the shim's MARVEEN_AGENT_NAME / MARVEEN_RELAY_DIR env keys are accepted. Delete the file and start the agent so it is re-rendered`)
  }
  const sandboxLines = new Set([
    'network_access = false',
    'exclude_slash_tmp = true',
    'exclude_tmpdir_env_var = true',
  ])
  const sandboxSeen = new Set<string>()
  let sandboxHeaders = 0
  const filesystemHeader = `[permissions.${CODEX_RELAY_PERMISSION_PROFILE}.filesystem]`
  const filesystemLines = new Set(identity === 'seat'
    ? codexRelayFilesystemEntries(workspace).map(([path, access]) => `${JSON.stringify(path)} = ${JSON.stringify(access)}`)
    : [])
  const filesystemSeen = new Set<string>()
  let filesystemHeaders = 0
  let defaultPermissionsSeen = false
  let tableSeen = false
  for (const rawLine of content.split('\n')) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    if (identity === 'seat') {
      if (line.includes('writable_roots')) refuseSeatConfig(`writable_roots is not allowed (${line})`)
      if (line.includes('default_permissions')) {
        if (line !== `default_permissions = ${JSON.stringify(CODEX_RELAY_PERMISSION_PROFILE)}` || tableSeen || defaultPermissionsSeen) {
          refuseSeatConfig(`unexpected or duplicate default_permissions setting (${line})`)
        }
        defaultPermissionsSeen = true
      }
      if (line.startsWith('[')) {
        tableSeen = true
        if (line === filesystemHeader) {
          filesystemHeaders += 1
          if (filesystemHeaders > 1) refuseSeatConfig('the relay filesystem table must appear exactly once')
        } else if (line.includes('permissions') || line.includes('extends')) {
          refuseSeatConfig(`unexpected permissions table (${line})`)
        }
      } else if (currentKey === filesystemHeader) {
        if (!filesystemLines.has(line) || filesystemSeen.has(line)) refuseSeatConfig(`unexpected or duplicate relay filesystem setting (${line})`)
        filesystemSeen.add(line)
      } else if (line.includes('permissions.') || line.includes('extends')) {
        refuseSeatConfig(`permissions settings outside the relay filesystem table (${line})`)
      }
      if (line === '[sandbox_workspace_write]') {
        sandboxHeaders += 1
        if (sandboxHeaders > 1) refuseSeatConfig('the sandbox_workspace_write table must appear exactly once')
      } else if (!line.startsWith('[') && currentKey === '[sandbox_workspace_write]') {
        if (!sandboxLines.has(line) || sandboxSeen.has(line)) refuseSeatConfig(`unexpected or duplicate sandbox_workspace_write setting (${line})`)
        sandboxSeen.add(line)
      } else if (['sandbox_workspace_write', 'writable_roots', 'exclude_slash_tmp', 'exclude_tmpdir_env_var', 'network_access'].some(key => line.includes(key))) {
        refuseSeatConfig(`sandbox settings outside the sandbox_workspace_write table (${line})`)
      }
    }
    let violation = false
    // Compare headers as written: any whitespace inside a header mentioning mcp_servers is refused,
    // because the dashboard entry is located by its exact header text. Quoted or escaped table names
    // off the allowed list, and headers or keys carrying a backslash, are also refused rather than normalized.
    if (line.startsWith('[')) {
      currentKey = line
      if (line === '[mcp_servers."marveen-dashboard"]' || line === '[mcp_servers.marveen-dashboard]') dashboardSeen = true
      // An array-of-tables header ([[...]]) is never on the allowed list, so it falls to the last branch.
      if (line.includes('\\')) violation = true
      else if (line.includes('mcp_servers') && !allowedHeaders.includes(line)) violation = true
    } else if (line.includes('mcp_servers')) {
      violation = true
    } else if (line.includes('=') && line.slice(0, line.indexOf('=')).includes('\\')) {
      violation = true
    } else if (currentKey === '[mcp_servers]') {
      // Directly under [mcp_servers] every key names a server (x = {...}, x.command = ...), so no line is allowed.
      violation = true
    } else if (currentKey === '[mcp_servers."marveen-dashboard"]' || currentKey === '[mcp_servers.marveen-dashboard]') {
      if (line === 'command = "node"' && !commandSeen) commandSeen = true
      else if (line === argsLine && !argsSeen) argsSeen = true
      else refuseShimEntry(line)
    } else if (currentKey === '[mcp_servers."marveen-dashboard".env]' || currentKey === '[mcp_servers.marveen-dashboard.env]') {
      // The whole line must be one shim key and a one-line string without quotes or escapes: a value that opens a
      // multi-line string or array could make a later line look like a table header to this scan.
      if (!/^(?:"MARVEEN_AGENT_NAME"|MARVEEN_AGENT_NAME|"MARVEEN_RELAY_DIR"|MARVEEN_RELAY_DIR)\s*=\s*"[^"\\]*"$/.test(line)) refuseShimEntry(line)
      if (identity === 'seat') {
        const [, key, value] = line.match(/^"?(MARVEEN_AGENT_NAME|MARVEEN_RELAY_DIR)"?\s*=\s*"([^"\\]*)"$/)!
        if (value !== (key === 'MARVEEN_AGENT_NAME' ? opts.agentName : relayDir)) refuseSeatConfig(`incorrect ${key} in the relay shim env`)
      }
    }
    if (violation) {
      throw new Error(
        `codexSandbox=relay refuses the existing ${configPath}: it defines an MCP server other than marveen-dashboard (${line}), and under relay only the dashboard relay shim may run. Remove that entry from ${configPath}, or delete the file and start the agent so it is re-rendered`)
    }
  }
  if (identity === 'seat' && (sandboxHeaders !== 1 || sandboxSeen.size !== sandboxLines.size)) {
    refuseSeatConfig('the sandbox_workspace_write table must contain exactly the three relay sandbox settings')
  }
  if (identity === 'seat' && !defaultPermissionsSeen) refuseSeatConfig('default_permissions must name the relay profile exactly once before any table')
  if (identity === 'seat' && (filesystemHeaders !== 1 || filesystemSeen.size !== filesystemLines.size)) {
    refuseSeatConfig('the relay filesystem table must contain exactly the rendered filesystem entries for this workspace')
  }
  if (dashboardSeen && (!commandSeen || !argsSeen)) refuseShimEntry('missing command/args')
  if (identity === 'seat' && content.includes('\\')) {
    throw new Error(
      `codexSandbox=relay refuses the existing ${configPath}: it contains a backslash (a TOML escape), which this check cannot decode, so an escaped 'danger-full-access' could hide behind it. Delete the file and start the agent so it is re-rendered`)
  }
}

function projectCodexEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    const code = error.code ?? error.message
    throw new Error(`codexSandbox=relay cannot check ${path} (${code}); refusing to start (fail closed)`)
  }
}

function codexProjectLevels(start: string): string[] {
  let levels: string[] = []
  for (let dir = start; ; dir = dirname(dir)) {
    levels.push(dir)
    if (projectCodexEntryExists(join(dir, '.git'))) break
    if (dirname(dir) === dir) {
      levels = [start]
      break
    }
  }
  return levels
}

// Codex loads .codex/config.toml from every trusted directory between the git root
// and workspace (inclusive), or only the workspace without a git root. Relay must
// refuse any .codex entry there: its MCP servers would run next to the sandbox.
// The launcher `cd`s into the workspace, so Codex walks from the physical working
// directory; both the lexical and physical chains are checked.
export function assertNoProjectCodexConfig(workspace: string, opts: CodexRenderOptions = {}): void {
  if (opts.profile !== 'relay') return
  const lexical = resolve(workspace)
  let physical: string | undefined
  try {
    physical = realpathSync(lexical)
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      const code = error.code ?? error.message
      throw new Error(`codexSandbox=relay cannot resolve ${lexical} (${code}); refusing to start (fail closed)`)
    }
  }
  const levels = new Set([
    ...codexProjectLevels(lexical),
    ...(physical === undefined ? [] : codexProjectLevels(physical)),
  ])
  for (const level of levels) {
    const candidate = join(level, '.codex')
    if (projectCodexEntryExists(candidate)) {
      throw new Error(`codexSandbox=relay refuses ${candidate}: Codex loads .codex/config.toml from every trusted directory between the project root and the workspace, so an MCP server defined there would run next to the relay sandbox. Remove or move ${candidate}, then start the agent`)
    }
  }
}

export function preflightCodexHome(home: string, workspace: string, servers: Record<string, unknown>, identity: CodexIdentity = 'seat', opts: CodexRenderOptions = {}): void {
  assertCodexSeatConfigCompatible(home, workspace, identity, opts)
  assertNoProjectCodexConfig(workspace, opts)
  // Validation only, before anything is written: in overrides mode the seat's
  // config.toml (which may belong to another agent) is deliberately not consulted.
  if (identity === 'overrides') {
    renderCodexOverrides(workspace, servers, opts)
    return
  }
  if (existsSync(join(home, 'config.toml'))) return
  renderCodexConfig(workspace, servers, opts)
}

/** Seed only once: operator edits remain the source of truth on subsequent starts. */
export function scaffoldCodexHome(home: string, workspace: string, servers: Record<string, unknown>, identity: CodexIdentity = 'seat', opts: CodexRenderOptions = {}): void {
  assertCodexSeatConfigCompatible(home, workspace, identity, opts)
  assertNoProjectCodexConfig(workspace, opts)
  const dropped = relayDroppedMcpServers(servers, opts)
  if (dropped.length) logger.warn({ workspace, dropped }, 'codexSandbox=relay: inherited MCP servers are not rendered; only the dashboard relay shim runs under relay')
  if (identity === 'overrides') {
    // Shared seat: never create or touch <home>/config.toml, and never chmod the
    // home directory. The agent's identity lives in its OWN workspace, mode 0600
    // (it names the MCP server and can carry literal token values).
    atomicWriteFileSync(join(workspace, '.codex-overrides'), `${renderCodexOverrides(workspace, servers, opts).join('\n')}\n`, { mode: 0o600 })
    syncCodexInstructions(workspace)
    return
  }
  const configPath = join(home, 'config.toml')
  const config = existsSync(configPath) ? null : renderCodexConfig(workspace, servers, opts)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  if (config !== null) {
    try {
      writeFileSync(configPath, config, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  syncCodexInstructions(workspace)
}

export function syncCodexInstructions(workspace: string): void {
  const source = join(workspace, 'CLAUDE.md')
  if (existsSync(source)) atomicWriteFileSync(join(workspace, 'AGENTS.md'), readFileSync(source))
}
