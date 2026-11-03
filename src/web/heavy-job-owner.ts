// Which heavy-job gate (scripts/heavy-job-gate.sh) jobs belong to an agent
// right now?
//
// A context-guard restart kills the agent's pane, and with it every process the
// agent started: a gated job that runs or waits as a descendant of the agent's
// Bash tool gets SIGTERM (a running job ends with 143, a queued one is refused
// with reason=signal and never starts). Measured on a production install: a
// restart whose reason was "handoff written" (the pane looked idle because the
// test ran in the background) stopped a gated test run after 2182 s, with no
// result. The guard holds the restart while this module finds a live gated job
// in the agent's tree.
//
// Sources, both written by scripts/heavy-job-gate.py (paths resolved the way
// the gate resolves them, see heavyJobPaths):
//   - the lock record (<store>/.heavy-job.lock, "token=.. pid=<gate pid>
//     unit=.. since=.. label=<label> ..."): the RUNNING job. The record
//     outlives the job, so the pid must be alive and still a heavy-job-gate
//     process (pid reuse);
//   - the FIFO queue (<store>/.heavy-job-queue/*.ticket, JSON {pid, start,
//     label, ...}): the QUEUED jobs, judged exactly like the gate judges a
//     ticket (alive, not a zombie, same start time).
// Ownership is the process tree, not the label: a job is the agent's iff the
// gate process descends from the agent's tmux pane. Labels are free text, and
// a label match would hold one agent's restart for another agent's job.
//
// Linux only (/proc); elsewhere nothing is found and the guard behaves as before.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { exactTmuxTarget } from '../tmux-target.js'
import { dirname, join } from 'node:path'

export interface GatedJob {
  /** The gate process (heavy-job-gate.py) pid. */
  pid: number
  label: string
  state: 'running' | 'queued'
  /** The gate process's start time (/proc stat field 22): pid + start is the
   *  process identity, so a reused pid never reads as the same job. */
  start: string
}

export interface ProcInfo { ppid: number; start: string; state: string; cmdline: string }

export interface HeavyJobDeps {
  /** File content, or null if it does not exist. Any other read error THROWS:
   *  an unreadable lock or queue is "unmeasurable", never "no job". */
  readFile: (path: string) => string | null
  /** Directory entries, [] if it does not exist; other errors throw. */
  listDir: (path: string) => string[]
  /** Process info, or null if there is no such process. Any other read
   *  error throws (unmeasurable). */
  proc: (pid: number) => ProcInfo | null
}

export interface HeavyJobPaths { lock: string; queueDir: string; log: string }

/**
 * Where the gate keeps its lock record, queue and log, resolved exactly like
 * scripts/heavy-job-gate.py does: HEAVY_JOB_STORE, else <projectRoot>/store;
 * HEAVY_JOB_LOCK and HEAVY_JOB_LOG override the single files, and the queue
 * is HEAVY_JOB_QUEUE_DIR, else .heavy-job-queue next to the lock file. An
 * empty variable counts as unset (the gate's `os.environ.get(name) or
 * default`). Read from the dashboard's own environment: an owner who moves
 * the store for the agents must set the same variable for the dashboard.
 */
export function heavyJobPaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env): HeavyJobPaths {
  const store = env.HEAVY_JOB_STORE || join(projectRoot, 'store')
  const lock = env.HEAVY_JOB_LOCK || join(store, '.heavy-job.lock')
  return {
    lock,
    queueDir: env.HEAVY_JOB_QUEUE_DIR || join(dirname(lock), '.heavy-job-queue'),
    log: env.HEAVY_JOB_LOG || join(store, 'heavy-job-log.jsonl'),
  }
}

// The gate process's argv carries its script name (the .sh wrapper execs
// `python3 .../heavy-job-gate.py`), so a reused pid running anything else
// never reads as a gate.
const GATE_MARK = 'heavy-job-gate'
const MAX_ANCESTOR_HOPS = 64

/** "No such process" -- and only that -- reads as gone. Any other /proc read
 *  error (EACCES under hidepid, EIO, ...) THROWS: an unreadable process is
 *  "unmeasurable", never "no job", and never a job the restart "killed". */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ESRCH'
}

/** ppid, start time (field 22) and state from a /proc/<pid>/stat line. comm
 *  may contain spaces and ')': split after the LAST ')' like the gate does. A
 *  line that does not parse THROWS: unmeasurable, never "no such process". */
export function parseProcStat(stat: string, pid = 0): { ppid: number; start: string; state: string } {
  const close = stat.lastIndexOf(')')
  const rest = close < 0 ? [] : stat.slice(close + 1).trim().split(/\s+/)
  const ppid = parseInt(rest[1] ?? '', 10)
  if (!Number.isFinite(ppid) || rest[19] === undefined || !rest[0]) throw new Error(`unparsable /proc/${pid}/stat`)
  return { ppid, start: rest[19], state: rest[0] }
}

function readProc(pid: number): ProcInfo | null {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
  const { ppid, start, state } = parseProcStat(stat, pid)
  let cmdline = ''
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' ').trim()
  } catch (err) {
    // exited in between: an empty cmdline fails the gate-mark check
    if (!isGone(err)) throw err
  }
  return { ppid, start, state, cmdline }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

export const liveHeavyJobDeps: HeavyJobDeps = {
  readFile: (p) => {
    try { return readFileSync(p, 'utf-8') } catch (err) { if (isEnoent(err)) return null; throw err }
  },
  listDir: (p) => {
    try { return readdirSync(p) } catch (err) { if (isEnoent(err)) return []; throw err }
  },
  proc: readProc,
}

/** The lock record's key=value fields; the first occurrence of a key wins. */
export function parseLockRecord(text: string): Record<string, string> {
  const rec: Record<string, string> = {}
  for (const field of text.split(/\s+/)) {
    const i = field.indexOf('=')
    if (i <= 0) continue
    const k = field.slice(0, i)
    if (!(k in rec)) rec[k] = field.slice(i + 1)
  }
  return rec
}

/** Is the gate process pid (with this start time) still alive? The fact the
 *  guard's restart report is built from (before and after its restart).
 *  Throws when /proc cannot be read for it (see readProc). */
export function gateAlive(pid: number, start: string, deps: HeavyJobDeps): boolean {
  return isLiveGate(deps.proc(pid), start)
}

function isLiveGate(info: ProcInfo | null, start?: unknown): info is ProcInfo {
  if (!info || info.state === 'Z' || info.state === 'X') return false
  if (!info.cmdline.includes(GATE_MARK)) return false
  return start === undefined || start === null || String(start) === info.start
}

/** Labels are free text; they go into alerts and the resume directive, so
 *  only [A-Za-z0-9._:-] is kept (runs of anything else become one '_'). */
function cleanLabel(v: unknown): string {
  return String(v ?? '?').replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 100) || '?'
}

/** Every live gated job on the host: the lock holder and the queued waiters. */
export function liveGatedJobs(deps: HeavyJobDeps, paths: HeavyJobPaths): GatedJob[] {
  const jobs: GatedJob[] = []
  const seen = new Set<number>()
  const lockText = deps.readFile(paths.lock)
  if (lockText) {
    const rec = parseLockRecord(lockText)
    const pid = parseInt(rec.pid ?? '', 10)
    const info = Number.isInteger(pid) && pid > 1 ? deps.proc(pid) : null
    if (isLiveGate(info)) {
      jobs.push({ pid, label: cleanLabel(rec.label), state: 'running', start: info.start })
      seen.add(pid)
    }
  }
  for (const name of deps.listDir(paths.queueDir).sort()) {
    if (!name.endsWith('.ticket')) continue
    const text = deps.readFile(join(paths.queueDir, name))
    if (text === null) continue
    let info: unknown
    try { info = JSON.parse(text) } catch { continue }
    if (!info || typeof info !== 'object') continue
    const t = info as Record<string, unknown>
    const pid = t.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || seen.has(pid)) continue
    const proc = deps.proc(pid)
    if (!isLiveGate(proc, t.start)) continue
    jobs.push({ pid, label: cleanLabel(t.label), state: 'queued', start: proc.start })
    seen.add(pid)
  }
  return jobs
}

/** True iff pid descends from one of rootPids (the agent's pane leaders). */
export function descendsFrom(pid: number, rootPids: Set<number>, deps: HeavyJobDeps): boolean {
  let cur: number | undefined = pid
  const seen = new Set<number>()
  for (let hops = 0; cur !== undefined && cur > 1 && hops < MAX_ANCESTOR_HOPS; hops++) {
    if (rootPids.has(cur)) return true
    if (seen.has(cur)) return false
    seen.add(cur)
    cur = deps.proc(cur)?.ppid
  }
  return false
}

export function agentHeavyJobs(
  rootPids: number[],
  deps: HeavyJobDeps,
  paths: HeavyJobPaths,
): GatedJob[] {
  const roots = new Set(rootPids.filter((p) => Number.isInteger(p) && p > 1))
  if (roots.size === 0) return []
  return liveGatedJobs(deps, paths).filter((j) => descendsFrom(j.pid, roots, deps))
}

/**
 * Pane leader pids of every window of a tmux session; null when tmux cannot
 * say. `invoke` turns tmux args into the runnable -- the caller passes
 * agent-process's tmuxInvocationFor, the fleet's one place that resolves an
 * agent running under its own OS user (a raw tmux call would ask the wrong
 * server there).
 */
export function sessionPanePids(
  session: string,
  invoke: (tmuxArgs: string[]) => { file: string; args: string[] },
): number[] | null {
  try {
    const inv = invoke(['list-panes', '-s', '-t', exactTmuxTarget(session), '-F', '#{pane_pid}'])
    const out = execFileSync(inv.file, inv.args, {
      timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pids = out.split('\n').map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isInteger(n) && n > 1)
    return pids.length > 0 ? pids : null
  } catch {
    return null
  }
}
