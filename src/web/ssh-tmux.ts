import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'

// SSH + tmux transport primitives.
//
// Every tmux operation against a remote agent is routed through here so the
// quoting and connection-option logic lives in ONE airtight, unit-tested place.
// When `host` is null these helpers reduce to a bare local tmux call (the exact
// pre-remote behavior); when `host` is set the tmux command is shell-quoted and
// wrapped in `ssh <opts> <host> '<quoted tmux cmd>'`.
//
// SECURITY: shQuote is the injection boundary. Remote tmux args include
// arbitrary inter-agent message content (via `send-keys -l <chunk>`), so a
// quoting flaw here is a remote command injection. POSIX single-quoting is the
// canonical airtight escape: wrap in single quotes, and replace every embedded
// single quote with the four-char sequence '\'' (close-quote, escaped-quote,
// open-quote). Inside single quotes EVERYTHING else (spaces, $, ;, &, globs,
// brackets) is literal.

/** POSIX single-quote a string so it survives re-parsing by a remote shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Private ControlMaster socket directory. `/tmp/<file>` is world-writable on
// Linux (sticky-bit 1777) which permits a pre-creation socket-hijack race;
// XDG_RUNTIME_DIR (mode 0700, per-user) avoids it. Falls back to a per-uid
// /tmp subdir that we create mode 0700 ourselves.
export function controlDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && xdg.trim()) return join(xdg.trim(), 'marveen-ssh')
  // No XDG_RUNTIME_DIR (rare on the Linux target): a per-user private /tmp dir.
  // getuid is always present on Linux; the no-getuid fallback (non-POSIX) uses
  // the username so distinct users never collide on the same /tmp path.
  let id: string
  if (typeof process.getuid === 'function') id = String(process.getuid())
  else { try { id = userInfo().username } catch { id = 'default' } }
  return `/tmp/marveen-ssh-${id}`
}

/** ControlMaster socket path template (ssh expands %r/%h/%p itself). */
export const CONTROL_PATH: string = join(controlDir(), 'cm-%r@%h:%p')

// Shared ssh options for every remote call.
//  - BatchMode=yes        : never block on an interactive auth prompt.
//  - ConnectTimeout=5     : bound the TCP handshake when the host is offline.
//  - ServerAliveInterval/CountMax: detect an alive-but-unresponsive remote in
//    ~4s (ConnectTimeout alone does NOT bound a hung post-connect command).
//  - ControlMaster=auto + ControlPersist=60 : multiplex one connection so the
//    5s delivery loop / watchers reuse it instead of re-handshaking each tick.
export const SSH_OPTS: readonly string[] = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=2',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${CONTROL_PATH}`,
  '-o', 'ControlPersist=60',
]

export interface TmuxInvocation {
  file: string
  args: string[]
}

/**
 * Build the {file, args} to run `tmux <tmuxArgs>` locally (host null) or on a
 * remote host over ssh. The remote command rides as ONE shell-quoted string so
 * the remote shell re-parses it back into the same argv.
 */
export function buildTmuxInvocation(
  host: string | null,
  localTmuxBin: string,
  tmuxArgs: string[],
  remoteTmuxBin = 'tmux',
): TmuxInvocation {
  if (host == null) return { file: localTmuxBin, args: tmuxArgs }
  // remoteTmuxBin is a trusted constant ('tmux'); only the args carry data, so
  // only the args are quoted. The whole thing is a single argv element for ssh.
  const remoteCmd = [remoteTmuxBin, ...tmuxArgs.map(shQuote)].join(' ')
  return { file: 'ssh', args: [...SSH_OPTS, host, remoteCmd] }
}

/**
 * Build an ssh invocation for a raw remote command (e.g. `which claude`, or a
 * `test -d <shQuoted path>` probe). The caller is responsible for shQuoting any
 * data embedded in `remoteCmd`.
 */
export function buildSshExec(host: string, remoteCmd: string): TmuxInvocation {
  return { file: 'ssh', args: [...SSH_OPTS, host, remoteCmd] }
}

/** True when `session` appears as an exact line in `tmux list-sessions` output. */
export function sessionInList(listOutput: string, session: string): boolean {
  return listOutput.split('\n').some(line => line.trim() === session)
}

export type AgentRunState = 'running' | 'stopped' | 'unreachable'

/**
 * Classify an agent's run state from a `tmux list-sessions` result. `listOutput`
 * is null when the query itself failed (exec threw / ssh error). For a remote
 * agent a failed query means "unreachable" (the session is almost certainly
 * still alive on the laptop, we just cannot see it) -- NOT "stopped", so callers
 * never auto-restart or double-start it. For a local agent a failed query means
 * there is no tmux server, i.e. stopped.
 */
export function classifyRunState(
  listOutput: string | null,
  session: string,
  isRemote: boolean,
): AgentRunState {
  if (listOutput == null) return isRemote ? 'unreachable' : 'stopped'
  return sessionInList(listOutput, session) ? 'running' : 'stopped'
}

/**
 * Classify run state when the `tmux list-sessions` probe FAILED (threw), from
 * the exec exit status. The key distinction for a remote agent: `tmux
 * list-sessions` exits non-zero ("no server running", typically 1) on a
 * perfectly REACHABLE laptop that simply has no tmux server/session yet -- that
 * is 'stopped' (and must be startable), NOT 'unreachable'. Only a real ssh
 * transport failure (exit 255) or a killed/timed-out connection (no numeric
 * status) is 'unreachable'. Local failures are always 'stopped' (no tmux server).
 */
export function classifyRunStateFromExit(
  exitStatus: number | null | undefined,
  isRemote: boolean,
): AgentRunState {
  if (!isRemote) return 'stopped'
  if (typeof exitStatus === 'number' && exitStatus !== 255) return 'stopped'
  return 'unreachable'
}

/**
 * Build the channel-less remote launch command run inside `tmux new-session -d`.
 * Uses the laptop's own `~/.claude` login (no token/vault/CLAUDE_CONFIG_DIR env,
 * no --channels). PATH covers both macOS (/opt/homebrew) and Linux ($HOME/.local)
 * binary locations. The model is shell-quoted so a `[1m]` suffix is not globbed.
 */
export function buildRemoteLaunchCommand(opts: {
  workdir: string
  model: string
  continue: boolean
}): string {
  const path = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"'
  const cont = opts.continue ? '--continue ' : ''
  return `${path} && cd ${shQuote(opts.workdir)} && claude ${cont}--dangerously-skip-permissions --model ${shQuote(opts.model)}`
}

/**
 * Build the remote `test -d` command that probes whether a prior Claude Code
 * session dir exists for an absolute workdir (so the launcher knows whether to
 * pass --continue). $HOME MUST stay outside the single-quoted region so the
 * remote shell expands it; only the validated, leading-dash-encoded segment is
 * single-quoted. The two adjacent quotings concatenate into one path word, so
 * the leading '-' is never parsed as a `test` flag. (shQuoting the whole path --
 * including $HOME -- would test a directory literally named "$HOME", which never
 * exists, silently dropping --continue on every remote launch.)
 */
export function buildContinueProbeCommand(absWorkdir: string): string {
  const encoded = absWorkdir.replace(/\//g, '-')
  return 'test -d "$HOME/.claude/projects/"' + shQuote(encoded)
}

let controlDirEnsured = false

/** Create the private ControlMaster socket dir (mode 0700) once, best-effort. */
export function ensureControlDir(): void {
  if (controlDirEnsured) return
  try {
    mkdirSync(controlDir(), { recursive: true, mode: 0o700 })
    controlDirEnsured = true
  } catch {
    /* best effort: a missing dir only costs us connection multiplexing */
  }
}

/**
 * Drop a dead/stale ControlMaster master for `host` before a fresh connection.
 * After a marveen restart the previous run's socket can linger; with
 * BatchMode=yes a dead socket may fail fast instead of falling back, so we
 * proactively tell ssh to exit any existing master. No master => harmless error.
 */
export function cleanStaleSshSockets(host: string): void {
  try {
    execFileSync('ssh', ['-O', 'exit', '-o', `ControlPath=${CONTROL_PATH}`, host], {
      timeout: 3000,
      stdio: 'ignore',
    })
  } catch {
    /* no live master to drop -- expected on the common path */
  }
}
