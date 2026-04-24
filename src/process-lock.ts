// Pure-logic module for acquiring an exclusive lock on a TCP port.
//
// Context: when the dashboard restarts under macOS launchd KeepAlive, a
// previous instance whose shutdown hung on live HTTP connections can remain
// alive in zombie state -- event loop still ticking, scheduled-task timers
// still firing, but the listening socket is already released (taken by a
// successor, or closed by server.close with closeAllConnections). The new
// instance then runs in parallel, the scheduler's tmux pane snapshots see
// conflicting state, and scheduled prompts land in the wrong place or never
// submit. This helper takes over the port deterministically on startup:
// find every own-UID node/tsx process that is either holding WEB_PORT or
// whose command line matches the dashboard binary, SIGTERM them, wait a
// grace period, and SIGKILL survivors.
//
// The logic is split from the I/O so the ctx can be mocked in tests --
// SIGKILL escalation ordering is impossible to unit-test against the real
// process table.

type LogFn = (obj: Record<string, unknown>, msg?: string) => void

/** Outcome of signal(). 'sent' = delivered to a live process. 'gone' = the
 * process is already dead (ESRCH). Any other error must throw so callers
 * can distinguish "probably still alive but we can't probe" from "gone". */
export type SignalOutcome = 'sent' | 'gone'

export interface ProcessLockContext {
  currentPid: number
  /** Effective UID of the current process, or null on platforms without getuid. */
  uid: number | null
  /** List PIDs currently bound to the given TCP port (typically via `lsof -ti`). */
  listPortHolders(port: number): number[]
  /** List own-UID PIDs whose argv matches `pattern` (typically via `ps -A -o pid,uid,args`).
   * Used to catch zombies that have already lost the listening socket but
   * are still running. Must exclude the current PID. */
  listOwnProcessesMatching(pattern: RegExp): number[]
  /** Return the command/comm of the PID, or null if the process is gone. */
  getProcessCommand(pid: number): string | null
  /** Return the owning UID of the PID, or null if the process is gone. */
  getProcessUid(pid: number): number | null
  /**
   * Send a signal. Signal 0 is the liveness probe. Returns:
   *  - 'sent' if the signal was delivered (process alive for sig 0)
   *  - 'gone' only for ESRCH (the process no longer exists)
   * Any other failure (EPERM, EINVAL, ...) MUST throw so the caller can
   * assume the process is still alive and escalate to SIGKILL.
   */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0): SignalOutcome
  sleep(ms: number): Promise<void>
  log: { info: LogFn; warn: LogFn; error: LogFn }
}

export interface AcquirePortLockOptions {
  /** How long to wait between SIGTERM and the liveness probe before SIGKILL. */
  graceMs?: number
  /** If set, also terminate own-UID processes whose argv matches this regex,
   * regardless of port holding. Catches zombies that already lost the port. */
  binaryPattern?: RegExp
  /** After SIGKILL, poll listPortHolders until the port is free or this
   * timeout elapses. Prevents a TIME_WAIT / LAST_ACK kernel state from
   * triggering EADDRINUSE on server.listen() immediately after a hard kill.
   * Default 2000ms. Set to 0 to disable polling. */
  postKillDrainMs?: number
  /** Poll interval for the post-kill drain. Default 100ms. */
  postKillPollMs?: number
}

const DEFAULT_GRACE_MS = 1500
const DEFAULT_POST_KILL_DRAIN_MS = 2000
const DEFAULT_POST_KILL_POLL_MS = 100

/**
 * Enumerate port holders that are safe to terminate: own-UID node/tsx
 * processes, excluding the current PID. Foreign-UID holders and non-node
 * commands are left alone and logged so the caller doesn't silently kill
 * an unrelated process (e.g. a dev server that happens to share the port).
 */
export function findOwnNodeHolders(port: number, ctx: ProcessLockContext): number[] {
  const raw = ctx.listPortHolders(port)
  return filterOwnNodeCandidates(raw, ctx)
}

/**
 * Enumerate own-UID node/tsx processes whose argv matches `pattern`,
 * excluding the current PID. Complements `findOwnNodeHolders` for the
 * case where a previous dashboard is still running but already lost its
 * listening socket.
 */
export function findOwnBinaryMatches(pattern: RegExp, ctx: ProcessLockContext): number[] {
  const raw = ctx.listOwnProcessesMatching(pattern)
  return filterOwnNodeCandidates(raw, ctx)
}

function filterOwnNodeCandidates(pids: number[], ctx: ProcessLockContext): number[] {
  const seen = new Set<number>()
  const holders: number[] = []
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0) continue
    if (pid === ctx.currentPid) continue
    if (seen.has(pid)) continue
    seen.add(pid)
    const cmd = ctx.getProcessCommand(pid)
    if (cmd == null) continue
    if (ctx.uid != null) {
      const ownerUid = ctx.getProcessUid(pid)
      if (ownerUid == null) continue
      if (ownerUid !== ctx.uid) {
        ctx.log.warn({ pid, ownerUid }, 'Port/binary holder owned by different UID, leaving alone')
        continue
      }
    }
    if (!/node|tsx/i.test(cmd)) {
      ctx.log.warn({ pid, cmd }, 'Port/binary holder is not a node/tsx process, leaving alone')
      continue
    }
    holders.push(pid)
  }
  return holders
}

/**
 * Best-effort terminate every PID in the list. Sends SIGTERM in parallel,
 * waits the grace window, then SIGKILLs any survivors. A liveness-probe
 * error that isn't ESRCH is treated as "still alive" so we escalate rather
 * than silently assume death (EPERM means the process exists but we can't
 * signal it; guessing 'gone' would leave a zombie running).
 */
export async function terminateProcesses(
  pids: number[],
  ctx: ProcessLockContext,
  opts: { graceMs: number },
): Promise<void> {
  if (!pids.length) return
  for (const pid of pids) {
    try {
      const out = ctx.signal(pid, 'SIGTERM')
      if (out === 'sent') ctx.log.info({ pid }, 'SIGTERM sent to previous instance')
    } catch (err) {
      ctx.log.warn({ pid, err }, 'SIGTERM failed, will still try SIGKILL after grace')
    }
  }
  await ctx.sleep(opts.graceMs)
  for (const pid of pids) {
    let alive = true
    try {
      const out = ctx.signal(pid, 0)
      alive = out !== 'gone'
    } catch {
      // Non-ESRCH error: assume still alive and escalate. Missing a SIGKILL
      // to an already-dead process is harmless; skipping SIGKILL on a live
      // zombie is the bug this helper exists to prevent.
      alive = true
    }
    if (!alive) continue
    try {
      ctx.log.warn({ pid }, 'Previous instance still alive after SIGTERM, escalating to SIGKILL')
      ctx.signal(pid, 'SIGKILL')
    } catch (err) {
      ctx.log.error({ pid, err }, 'SIGKILL failed')
    }
  }
}

/**
 * Make sure we are the only node/tsx dashboard process. If any own-UID
 * holders exist (listening on `port` OR matching `binaryPattern`), SIGTERM
 * then SIGKILL them. Returns once every holder is dead; the caller is free
 * to call server.listen() afterwards.
 */
export async function acquirePortLock(
  port: number,
  ctx: ProcessLockContext,
  opts: AcquirePortLockOptions = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const drainMs = opts.postKillDrainMs ?? DEFAULT_POST_KILL_DRAIN_MS
  const pollMs = opts.postKillPollMs ?? DEFAULT_POST_KILL_POLL_MS
  const byPort = findOwnNodeHolders(port, ctx)
  const byBinary = opts.binaryPattern ? findOwnBinaryMatches(opts.binaryPattern, ctx) : []
  const victims = Array.from(new Set([...byPort, ...byBinary]))
  if (!victims.length) return
  ctx.log.warn({ port, victims, matchedBy: { byPort, byBinary } }, 'Previous dashboard instance(s) detected, taking over')
  await terminateProcesses(victims, ctx, { graceMs })
  if (drainMs <= 0 || pollMs <= 0) return
  // Poll for the kernel to release the listening socket. Without this, a
  // SIGKILLed predecessor can leave the port in TIME_WAIT / LAST_ACK and
  // server.listen() will fail EADDRINUSE immediately after we return. The
  // post-sleep re-check matters: without it, the port might clear during
  // the final sleep and we'd still log "still held" noise.
  let waited = 0
  while (true) {
    if (!findOwnNodeHolders(port, ctx).length) return
    if (waited >= drainMs) break
    await ctx.sleep(pollMs)
    waited += pollMs
  }
  ctx.log.warn({ port }, 'Port still held after drain window, server.listen may hit EADDRINUSE and recover via reclaim')
}

/**
 * Drive a synchronous writer until the entire buffer is written. `writer`
 * is expected to behave like Node's writeSync (returns bytes written; may
 * be less than requested). Throws on `writer` returning 0 or negative,
 * which is not a legitimate "would block" for regular files.
 *
 * Extracted so the retry/slice logic is unit-testable without an fd.
 */
export function writeBufferFully(
  writer: (buf: Buffer, offset: number, length: number) => number,
  buf: Buffer,
): void {
  let written = 0
  while (written < buf.length) {
    const n = writer(buf, written, buf.length - written)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`writer returned ${n} with ${buf.length - written} bytes remaining`)
    }
    written += n
  }
}

// --- Exclusive pidfile lock (O_EXCL-based) ----------------------------------

/** Outcome of a single tryCreateExclusive attempt. */
export type ExclusiveCreateOutcome = 'created' | 'exists'

export interface PidfileLockContext {
  /** Try to create `path` atomically (O_EXCL) and write `pid` into it.
   * Returns 'created' on success, 'exists' if the file already exists.
   * Any other I/O error MUST throw so the caller fails loud. */
  tryCreateExclusive(path: string, pid: number): ExclusiveCreateOutcome
  /** Parse the PID recorded in `path`, or null if the file is missing /
   * corrupt. */
  readRecordedPid(path: string): number | null
  /** Remove `path` ONLY if its current content matches `expected`:
   *   - number: unlink only if the file parses to that PID
   *   - null:   unlink only if the file exists but is still non-parseable
   * Guards every unlink against a third peer racing a fresh O_EXCL win
   * into the slot while we were mid-decision. Silent on ENOENT and on
   * state-mismatch. */
  unlinkIfMatches(path: string, expected: number | null): void
  /** True if signal 0 to `pid` succeeds (process exists and we can signal
   * it). Non-ESRCH errors MUST throw so the caller can be defensive. */
  probeAlive(pid: number): boolean
  /** Send SIGTERM to `pid`. Silent on ESRCH. */
  sendTerm(pid: number): void
  /** Gate used to decide whether to SIGTERM the recorded PID. Returns true
   * only if the PID really looks like a previous instance (own UID + node/
   * tsx + argv matches the dashboard binary). When false, the file is
   * treated as stale from a crash whose PID was recycled to an unrelated
   * process. */
  isLegitimatePredecessor(pid: number): boolean
  sleep(ms: number): Promise<void>
  log: { info: LogFn; warn: LogFn; error: LogFn }
}

export interface AcquirePidfileLockOptions {
  /** Abort after this many failed attempts (default 5). */
  maxAttempts?: number
  /** How long to wait between SIGTERM and the retry. Default 1500ms. */
  graceMs?: number
  /** What to do when the recorded PID is alive AND legitimately a peer
   * dashboard process. Default 'sigterm' (kill predecessor, take over).
   * 'defer' throws DeferToPeerError instead; the caller should exit(0)
   * quietly. Used to resolve fresh-startup races where the winner is
   * already partway through init and SIGTERMing them could corrupt state
   * (e.g. SQLite WAL) before they installed their signal handlers. */
  onLiveLegitimate?: 'sigterm' | 'defer'
}

/** Thrown by acquirePidfileLock when a legitimate peer already holds the
 * pidfile and the caller asked for `onLiveLegitimate: 'defer'`. */
export class DeferToPeerError extends Error {
  readonly peerPid: number
  constructor(peerPid: number) {
    super(`Pidfile held by legitimate peer PID ${peerPid}`)
    this.name = 'DeferToPeerError'
    this.peerPid = peerPid
  }
}

/**
 * Atomically claim an O_EXCL pidfile, serialising two concurrent startups
 * even if they both passed the port check. If the file exists, inspect the
 * recorded PID: alive-and-legitimate -> SIGTERM and wait; alive-but-not-
 * legitimate (PID recycled to an unrelated process) -> treat as stale and
 * unlink; gone -> unlink. Bounded retry so a permanent problem fails loud
 * instead of spinning.
 */
export async function acquirePidfileLock(
  path: string,
  selfPid: number,
  ctx: PidfileLockContext,
  opts: AcquirePidfileLockOptions = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 5
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const onLiveLegitimate = opts.onLiveLegitimate ?? 'sigterm'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = ctx.tryCreateExclusive(path, selfPid)
    if (outcome === 'created') {
      ctx.log.info({ pid: selfPid, path }, 'Pidfile lock acquired')
      return
    }

    const recorded = ctx.readRecordedPid(path)
    if (recorded == null) {
      // File exists but parses to nothing (truncated write, corrupt). Only
      // unlink if the content is still non-parseable: a concurrent peer
      // may have rewritten it between our read and this call.
      ctx.unlinkIfMatches(path, null)
      continue
    }
    if (recorded === selfPid) {
      // Self-recorded from an earlier run whose PID happened to match
      // ours after recycling. Drop and retry (only if still unchanged).
      ctx.unlinkIfMatches(path, selfPid)
      continue
    }

    let alive = false
    try {
      alive = ctx.probeAlive(recorded)
    } catch {
      // Can't probe -- be conservative and assume alive.
      alive = true
    }
    if (!alive) {
      ctx.log.warn({ recorded }, 'Pidfile references dead PID, unlinking stale file')
      ctx.unlinkIfMatches(path, recorded)
      continue
    }

    if (!ctx.isLegitimatePredecessor(recorded)) {
      // PID was recycled to an unrelated program. SIGTERMing it would be
      // dangerous; instead treat the file as stale and move on.
      ctx.log.warn({ recorded }, 'Pidfile PID alive but not a dashboard process, treating as stale')
      ctx.unlinkIfMatches(path, recorded)
      continue
    }

    if (onLiveLegitimate === 'defer') {
      // Fresh-startup race: the peer won the O_EXCL race and is mid-init.
      // SIGTERMing them here could corrupt state (e.g. SQLite WAL, half-
      // applied migrations) because they have not yet installed their
      // signal handlers. Back off and let them proceed.
      ctx.log.info({ recorded }, 'Pidfile held by legitimate peer, deferring')
      throw new DeferToPeerError(recorded)
    }

    ctx.log.warn({ recorded }, 'Pidfile held by live predecessor, sending SIGTERM and retrying')
    try { ctx.sendTerm(recorded) } catch (err) {
      ctx.log.warn({ recorded, err }, 'SIGTERM to predecessor failed')
    }
    await ctx.sleep(graceMs)
    // Important: only unlink if the file still records THIS predecessor.
    // During our sleep, the predecessor's own releaseLock may have removed
    // it and a third startup's tryCreateExclusive may have written its
    // own PID into the slot -- unconditional unlink would nuke that
    // peer's legitimate lock and let two dashboards run concurrently.
    ctx.unlinkIfMatches(path, recorded)
  }
  throw new Error(`Failed to acquire pidfile lock at ${path} after ${maxAttempts} attempts`)
}
