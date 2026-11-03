// BASHSANDBOX1022 (kanban 79f60a8a): Claude Code's own Bash sandbox for the agents the owner lists.
//
// The bash-egress-parser hook reads the COMMAND LINE, so a script file run by Bash (`python3
// crawl.py`) reaches the network unseen: measured 2026-10-22 on a real agent. Claude Code 2.1.306
// ships a macOS Seatbelt sandbox for every Bash command and its children, with a filtering proxy
// in front of the network. The spike on that card measured what it takes for it to hold in THIS
// fleet, and every line of the settings below answers one measurement:
//   - network.strictAllowlist: the agents run with --dangerously-skip-permissions, and in that
//     mode a host outside allowedDomains is NOT refused -- the "allow this host?" prompt is
//     auto-approved (example.com and github.com went through). strictAllowlist denies instead of
//     asking, with or without bypass, and an unattended tmux session does not park on a prompt.
//     It is read from user and --settings sources, so no machine-wide managed setting is needed;
//   - the whole block travels in a --settings FILE: in a user settings.json, a project
//     .claude/settings.json or .claude/settings.local.json in the agent's own (writable) directory
//     switched the sandbox off with one key (sandbox.enabled: false -- raw socket out, any host).
//     From --settings the project file could neither turn it off nor add a host or a write path;
//   - allowUnsandboxedCommands: false: with true, a Bash call asking dangerouslyDisableSandbox ran
//     unsandboxed without a prompt in bypass mode;
//   - network.allowLocalBinding: the dashboard on localhost:3420 stays reachable (memory, kanban,
//     messages); the sandbox's NO_PROXY also keeps 127.0.0.1 and the private ranges direct;
//   - filesystem.allowWrite: Bash may write only its cwd and the temp dir by default; an agent's
//     worktrees and output folders have to be named.
// What it does NOT cover, measured: hooks and MCP servers run outside the sandbox and keep their
// network; the native Write/Edit tools are not sandboxed either. And a raw `RemoteDisconnected`
// came back from an allowed host in 2 of 13 sandboxed runs (cause unknown).
//
// The file lives under store/, outside every agent directory, and is rewritten on each start, so
// what the agent sees is always derived from the owner's two sources: the BASH_SANDBOX_AGENTS
// switch and store/egress-vendor-hosts.json (+ store/bash-sandbox-write-paths.json).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir } from './agent-config.js'

export const BASH_SANDBOX_DIR = join(STORE_DIR, 'bash-sandbox')
export const VENDOR_HOSTS_PATH = join(STORE_DIR, 'egress-vendor-hosts.json')
export const SANDBOX_WRITE_PATHS_PATH = join(STORE_DIR, 'bash-sandbox-write-paths.json')

// The shape bash-egress-parser.mjs accepts for a vendor entry: a plain DNS name, no wildcard, IP,
// port or userinfo. The same file feeds both gates, so it is read the same way here.
const VENDOR_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function bashSandboxSettingsPath(name: string, dir = BASH_SANDBOX_DIR): string {
  if (!AGENT_ID.test(name)) throw new Error(`bash-sandbox: not an agent id: ${JSON.stringify(name)}`)
  return join(dir, `${name}.settings.json`)
}

// The owner's switch: a list of agent ids, empty by default (off). The main agent is never
// sandboxed by it: its Bash is the operator's channel, and its respawners are separate scripts.
export function parseSandboxAgents(raw: unknown): Set<string> {
  const out = new Set<string>()
  for (const w of String(raw ?? '').split(/[\s,]+/)) {
    const id = w.trim().toLowerCase()
    if (id && AGENT_ID.test(id) && id !== MAIN_AGENT_ID) out.add(id)
  }
  return out
}
export function bashSandboxAgents(): Set<string> {
  try { return parseSandboxAgents(getEffectiveSettingValue('BASH_SANDBOX_AGENTS')) } catch { return new Set() }
}
export function bashSandboxEnabledFor(name: string): boolean {
  return bashSandboxAgents().has(name)
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

// allowedDomains from the vendor list: each "hosts" entry exactly, each "domains" entry as itself
// AND as *.domain (the parser lets a subdomain of a listed domain through, so the sandbox does too).
// A missing file is an empty list; a corrupt one throws -- the start is refused rather than
// guessing at the owner's list.
export function sandboxAllowedDomains(path = VENDOR_HOSTS_PATH): string[] {
  const raw = readJson(path) as { hosts?: unknown; domains?: unknown } | null
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error(`bash-sandbox: ${path} is not a JSON object`)
  const pick = (v: unknown) => (Array.isArray(v) ? v : []).filter((h): h is string => typeof h === 'string' && VENDOR_HOST.test(h))
  const out = new Set<string>(pick(raw?.hosts))
  for (const d of pick(raw?.domains)) { out.add(d); out.add(`*.${d}`) }
  return [...out].sort()
}

// The write paths: the agent's own directory, its worktree root, and what the owner lists for it in
// store/bash-sandbox-write-paths.json ({"agents": {"soma": ["~/Library/..."]}}). Only absolute
// paths (or ~/...) are taken, and never the filesystem root or the home directory itself.
export function sandboxWritePaths(name: string, path = SANDBOX_WRITE_PATHS_PATH, home = homedir()): string[] {
  const raw = readJson(path) as { agents?: Record<string, unknown> } | null
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error(`bash-sandbox: ${path} is not a JSON object`)
  const listed = raw?.agents && typeof raw.agents === 'object' ? raw.agents[name] : undefined
  const out = new Set<string>([agentDir(name), join(home, 'worktrees', name)])
  for (const p of Array.isArray(listed) ? listed : []) {
    if (typeof p !== 'string') continue
    const abs = normalize(p.startsWith('~/') ? join(home, p.slice(2)) : p)
    if (!isAbsolute(abs) || abs === '/' || abs === normalize(home) || abs === normalize(`${home}/`)) continue
    out.add(abs)
  }
  return [...out]
}

export function buildBashSandboxSettings(allowedDomains: string[], allowWrite: string[]): object {
  return {
    sandbox: {
      enabled: true,
      // A host where the sandbox cannot start must not quietly run the agent without it.
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { strictAllowlist: true, allowLocalBinding: true, allowedDomains },
      filesystem: { allowWrite },
    },
  }
}

// Writes the agent's --settings file and returns its path; throws when it cannot (the caller refuses
// the start). For an agent that is not listed, removes a stale file, so watchdog.sh -- which decides
// by the file's presence -- never sandboxes an agent the switch no longer names, nor misses one.
//
// The directory is kept read-only (0555, files 0444) between writes. Measured: the native Write and
// Edit tools write through a temp file in the same directory and fail with EACCES there (a 0444
// file alone does NOT stop them -- they replaced one), and a sandboxed Bash command cannot chmod or
// rename anything outside its write roots (EPERM). Claude Code does not re-read a --settings file
// mid-session either (a widened file swapped in under a running session left the host blocked), so
// a change could only take effect on a restart that reuses the file -- watchdog.sh does. What this
// does NOT stop: any process outside the sandbox running as the same user (another, unsandboxed
// agent's Bash, a hook, an MCP server) can chmod the directory back.
export function syncBashSandboxSettings(name: string, opts: { dir?: string; vendorPath?: string; writePathsPath?: string; enabled?: boolean } = {}): string | null {
  const dir = opts.dir ?? BASH_SANDBOX_DIR
  const enabled = opts.enabled ?? bashSandboxEnabledFor(name)
  // A name the switch could never list (the main agent, a legacy spelling) has no file to remove.
  if (!enabled && (!AGENT_ID.test(name) || !existsSync(bashSandboxSettingsPath(name, dir)))) return null
  const file = bashSandboxSettingsPath(name, dir)
  // Built before the directory is opened: a corrupt owner file throws with nothing touched.
  const data = enabled ? JSON.stringify(buildBashSandboxSettings(sandboxAllowedDomains(opts.vendorPath), sandboxWritePaths(name, opts.writePathsPath)), null, 2) + '\n' : null
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o755)
  try {
    if (data === null) { rmSync(file, { force: true }); return null }
    atomicWriteFileSync(file, data, { mode: 0o444 })
    return file
  } finally {
    chmodSync(dir, 0o555)
  }
}
