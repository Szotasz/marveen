/**
 * CODEXEVID d72ba2bd: where does a Codex-motor agent keep its transcript?
 *
 * Two watchers decided "did the agent see the prompt / start a turn" from the
 * CLAUDE CODE transcript only (delivery-turn-check.ts and
 * schedule-runner.ts's probeTurnEvidence). For the 8 agents on this install
 * whose tmux pane runs OpenAI Codex instead of Claude Code, that transcript
 * never moves, and both watchers went blind in the same direction:
 *   - 239 "delivered without transcript evidence" WARNs on 2026-11-15 alone
 *     (bence 97, webesdavid 66, levente 60, hcs-helia 8, guszti/avora/vppbot/
 *     tenderbot 2 each) -- every one a false alarm;
 *   - 38 "Scheduled injection never started a turn ... recording as lost"
 *     redeliveries that day (webesdavid 18, tenderbot 10, bence 8, guszti 2),
 *     58 since 11-14 -- every 'lost' verdict re-delivers the task, so each is
 *     a DUPLICATE task run.
 *
 * The missing evidence is on disk: the Codex rollout JSONL under
 * <CODEX_HOME>/sessions/YYYY/MM/DD/. Measured example (2026-11-15, a message
 * sent 12:07 local, in the recipient's rollout):
 *   {"timestamp":"2026-11-15T11:07:52.752Z","ordinal":8921,"type":"response_item",
 *    "payload":{"type":"message","id":"msg_...","role":"user",
 *               "content":[{"type":"input_text","text":"... msg_id:128547 ..."}]}}
 * and the running session file's mtime advances while the agent works.
 *
 * The RUNNING agent's CODEX_HOME is not configured anywhere the dashboard
 * reads; it is in the pane process env. For a codex-motor agent the tmux pane
 * pid (session `agent-<name>`, see agentSessionName in agent-process.ts) IS
 * the codex process -- measured on 3 agents, no descendant walk needed -- so
 * /proc/<panePid>/environ holds CODEX_HOME=<dir>.
 *
 * Contract (both watchers depend on it):
 *   - codexSessionDirsFor NEVER throws and NEVER logs environ contents: any
 *     failure (no tmux row, unreadable /proc, remote host, no sessions dir)
 *     is [] plus a debug line, so a Claude-Code agent or a broken lookup
 *     degrades to exactly today's behaviour. A remote agent has no local
 *     pane process, hence no CODEX_HOME here, hence [] -- remote semantics
 *     are untouched by construction.
 *   - positive results are cached per agent for ~30s: the lookup spawns
 *     tmux, and CODEX_HOME only moves when the pane is recreated, while the
 *     sweep asks on every tick. Empty results are NOT cached (an agent that
 *     just (re)started must be found on the next ask).
 */
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { agentSessionName } from './agent-process.js'

// Same budget the tmux calls in agent-process.ts use: a local tmux answers in
// single-digit milliseconds; 4s only ever elapses when tmux itself is wedged.
const TMUX_TIMEOUT_MS = 4_000
// sessions/YYYY/MM/DD/*.jsonl: the day directory sits three levels under the
// resolved sessions root.
const CODEX_WALK_DEPTH = 3
// How long a resolved CODEX_HOME is trusted (see the contract above).
const CACHE_TTL_MS = 30_000

/**
 * PURE. Find CODEX_HOME in an environ dump. /proc/<pid>/environ is
 * NUL-separated; newline separation is tolerated for other renderings of the
 * same data. An empty value is no home. PURE on purpose: no fs, no spawn, so
 * the parsing itself is trivially testable.
 */
export function parseCodexHome(environText: string): string | null {
  for (const entry of environText.split(/\0|\n/)) {
    if (!entry.startsWith('CODEX_HOME=')) continue
    const value = entry.slice('CODEX_HOME='.length).trim()
    return value !== '' ? value : null
  }
  return null
}

export interface CodexSessionDeps {
  /** All tmux rows as `#{session_name} #{pane_pid}`, one per line. */
  listPanes?: () => Promise<string>
  /** The NUL-separated environ of a pid (defaults to /proc/<pid>/environ). */
  readEnviron?: (pid: number) => Promise<string>
  /** Exists-check for <CODEX_HOME>/sessions. */
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>
  /** The tmux session name of an agent (defaults to agentSessionName). */
  sessionNameFor?: (agent: string) => string
  now?: () => number
}

const codexDirCache = new Map<string, { atMs: number; dirs: string[] }>()

/** Test hook: forget the per-agent CODEX_HOME cache. */
export function resetCodexSessionDirCache(): void {
  codexDirCache.clear()
}

// tmux is spawned here rather than importing runTmux from agent-process.ts:
// this module is imported by delivery-turn-check.ts (which the router loads),
// and keeping the spawn local keeps that graph free of a possible cycle. Same
// pattern as runTmux: capture stdout, kill on a timeout, reject on any error.
function listPanesViaTmux(): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_pid}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (err) {
      reject(err)
      return
    }
    let out = ''
    let settled = false
    const finish = (err: unknown, text?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(text ?? '')
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('tmux list-panes timed out'))
    }, TMUX_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (d) => { out += String(d) })
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      // Exit 1 is tmux's "no server running" -- an install with no tmux
      // sessions at all, i.e. no codex pane to find: not an error worth more
      // than the debug line the caller's [] path already logs.
      if (code === 0) finish(null, out)
      else finish(new Error(`tmux list-panes exited with ${code}`))
    })
  })
}

async function readProcEnviron(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/environ`, 'utf8')
}

/**
 * The rollout roots for an agent's Codex motor: [<CODEX_HOME>/sessions] when
 * the agent's pane runs codex with a readable sessions dir, [] otherwise.
 * Never throws; logs the resolved HOME PATH only, never environ contents.
 */
export async function codexSessionDirsFor(agent: string, deps: CodexSessionDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now
  const cached = codexDirCache.get(agent)
  if (cached != null && now() - cached.atMs < CACHE_TTL_MS) return cached.dirs
  const listPanes = deps.listPanes ?? listPanesViaTmux
  const readEnviron = deps.readEnviron ?? readProcEnviron
  const statDir = deps.stat ?? stat
  const sessionNameFor = deps.sessionNameFor ?? agentSessionName
  const sessionName = sessionNameFor(agent)
  try {
    let rows: string
    try {
      rows = await listPanes()
    } catch (err) {
      logger.debug({ agent, err: String(err) }, 'codex-transcript-root: tmux list-panes failed (no codex evidence)')
      return []
    }
    // Rows are `#{session_name} #{pane_pid}`; anchor on the separating space
    // so agent-dex cannot match agent-dex2's row.
    let pid: number | null = null
    for (const row of rows.split('\n')) {
      const trimmed = row.trimEnd()
      if (!trimmed.startsWith(`${sessionName} `)) continue
      const pidText = trimmed.slice(sessionName.length + 1).trim()
      if (/^\d+$/.test(pidText)) pid = Number(pidText)
    }
    if (pid == null) {
      logger.debug({ agent, sessionName }, 'codex-transcript-root: no tmux pane row for the agent session (no codex evidence)')
      return []
    }
    let environ: string
    try {
      environ = await readEnviron(pid)
    } catch (err) {
      logger.debug({ agent, pid, err: String(err) }, 'codex-transcript-root: pane environ unreadable (no codex evidence)')
      return []
    }
    const home = parseCodexHome(environ)
    if (home == null) {
      logger.debug({ agent, pid }, 'codex-transcript-root: no CODEX_HOME in the pane env (claude-motor agent, no codex evidence)')
      return []
    }
    const sessionsDir = join(home, 'sessions')
    try {
      if (!(await statDir(sessionsDir)).isDirectory()) throw new Error('not a directory')
    } catch {
      logger.debug({ agent, sessionsDir }, 'codex-transcript-root: CODEX_HOME has no sessions dir (no codex evidence)')
      return []
    }
    logger.debug({ agent, sessionsDir }, 'codex-transcript-root: codex rollout root resolved')
    const dirs = [sessionsDir]
    codexDirCache.set(agent, { atMs: now(), dirs })
    return dirs
  } catch (err) {
    // Belt and braces: the contract is [], never a throw, even if a code path
    // above changes shape later.
    logger.debug({ agent, err: String(err) }, 'codex-transcript-root: lookup failed (no codex evidence)')
    return []
  }
}

export interface CodexRolloutFsDeps {
  readdir?: typeof readdir
  stat?: typeof stat
}

/**
 * Every *.jsonl rollout file under the given roots, with its mtime. The walk
 * covers the sessions/YYYY/MM/DD layout (three levels) and tolerates files
 * sitting shallower. Unreadable directories/files are skipped, not fatal:
 * this feeds an evidence probe, and a hole in the walk means "no evidence",
 * never an error into the watchers.
 */
export async function codexRolloutFiles(
  dirs: readonly string[],
  deps: CodexRolloutFsDeps = {},
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const readdirD = deps.readdir ?? readdir
  const statD = deps.stat ?? stat
  const out: Array<{ path: string; mtimeMs: number }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    // Structural type: Dirent from readdir satisfies it, and injected test
    // doubles only need name + isDirectory.
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = await readdirD(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) await walk(path, depth - 1)
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          out.push({ path, mtimeMs: (await statD(path)).mtimeMs })
        } catch {
          // A rollout that cannot be stat'd cannot be read either; skipping it
          // leaves the verdict to the files that can be.
        }
      }
    }
  }
  for (const dir of dirs) await walk(dir, CODEX_WALK_DEPTH)
  return out
}

/**
 * The newest rollout mtime across the given roots, or null when nothing was
 * readable. This is the codex analogue of the Claude transcript mtime the
 * sawTurn probe reads: null means "no evidence", never "old".
 */
export async function codexRolloutMtime(dirs: readonly string[], deps: CodexRolloutFsDeps = {}): Promise<number | null> {
  let max: number | null = null
  for (const f of await codexRolloutFiles(dirs, deps)) {
    if (max == null || f.mtimeMs > max) max = f.mtimeMs
  }
  return max
}
