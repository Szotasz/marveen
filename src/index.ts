import {
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { STORE_DIR, WEB_PORT, ALLOWED_CHAT_ID } from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep, runDailyDigest } from './memory.js'
import { initHeartbeat, stopHeartbeat } from './heartbeat.js'
import { startWebServer } from './web.js'
import { logger } from './logger.js'
import {
  acquirePortLock,
  acquirePidfileLock,
  writeBufferFully,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
} from './process-lock.js'

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  (lite)
`

const PID_FILE = join(STORE_DIR, 'claudeclaw.pid')
// Hard-kill timeout: if graceful shutdown (HTTP drain + releaseLock) has not
// finished in this window, exit so launchd's KeepAlive isn't blocked by a
// hung socket. closeAllConnections (Node 18.2+) normally drains in ms, but
// a browser tab holding a chunked response might still stall close().
const SHUTDOWN_HARD_KILL_MS = 5000
// Match own-UID node processes whose argv contains the dashboard binary
// path, followed by whitespace or end-of-string. The delimiters are load-
// bearing: without them, `\b` matched `dist/index.js.map`, `dist/index.js.bak`
// and other sibling files, and unrelated editor/bundler processes touching
// those files would get SIGKILLed on startup.
const DASHBOARD_BINARY_PATTERN = /(?:^|[\s/])(?:dist\/index\.js|src\/index\.ts)(?:\s|$)/

// Build the I/O surface used by process-lock.ts. Kept here so the pure
// module stays testable with a mock ctx and never imports node:child_process
// or node:fs directly.
function buildProcessLockContext(): ProcessLockContext {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return {
    currentPid: process.pid,
    uid,
    listPortHolders(port: number): number[] {
      try {
        const raw = execSync(`lsof -ti :${port} 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' }).trim()
        if (!raw) return []
        return raw.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
      } catch {
        return []
      }
    },
    listOwnProcessesMatching(pattern: RegExp): number[] {
      // `ps -A -o pid=,uid=,args=` emits `<pid> <uid> <full argv>` per row.
      // Filter to own-UID rows whose argv matches `pattern`. Known edge
      // case: an argv that contains a literal newline will be split across
      // physical lines; such rows are dropped. Not a practical concern for
      // node/tsx invocations, but worth noting.
      try {
        const raw = execFileSync('/bin/ps', ['-Ao', 'pid=,uid=,args='], { timeout: 3000, encoding: 'utf-8' })
        const out: number[] = []
        for (const line of raw.split('\n')) {
          const trimmed = line.trimStart()
          if (!trimmed) continue
          const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/)
          if (!m) continue
          const pid = parseInt(m[1], 10)
          const rowUid = parseInt(m[2], 10)
          const argv = m[3]
          if (!Number.isFinite(pid) || pid <= 0) continue
          if (pid === process.pid) continue
          if (uid != null && rowUid !== uid) continue
          if (!pattern.test(argv)) continue
          out.push(pid)
        }
        return out
      } catch {
        return []
      }
    },
    getProcessCommand(pid: number): string | null {
      try {
        return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000, encoding: 'utf-8' }).trim() || null
      } catch {
        return null
      }
    },
    getProcessUid(pid: number): number | null {
      try {
        const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid='], { timeout: 2000, encoding: 'utf-8' }).trim()
        const parsed = parseInt(out, 10)
        return Number.isFinite(parsed) ? parsed : null
      } catch {
        return null
      }
    },
    signal(pid: number, sig): 'sent' | 'gone' {
      try {
        process.kill(pid, sig as NodeJS.Signals | 0)
        return 'sent'
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ESRCH') return 'gone'
        // EPERM and others: the process exists but we can't probe. Rethrow
        // so callers treat it as "still alive".
        throw err
      }
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
    log: {
      info: (obj, msg) => logger.info(obj, msg),
      warn: (obj, msg) => logger.warn(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    },
  }
}

function readRecordedPidFrom(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    // Strict parse: only pure digits. Guards against truncated writes
    // ("12345" partially landed as "1"), empty files from a crash between
    // openSync and writeSync, or accidental free-form content.
    if (!/^\d+$/.test(raw)) return null
    const parsed = parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

// Legitimacy check for the PID recorded in the pidfile. True only if the PID
// looks like a previous dashboard instance (own UID + node/tsx + argv
// matches the binary pattern). Prevents the acquire loop from SIGTERMing an
// unrelated process whose PID happens to appear in a stale pidfile (PID
// recycling on long-lived systems is routine).
function isLegitimateDashboardPid(pid: number, procCtx: ProcessLockContext): boolean {
  const cmd = procCtx.getProcessCommand(pid)
  if (cmd == null) return false
  if (procCtx.uid != null) {
    const ownerUid = procCtx.getProcessUid(pid)
    if (ownerUid == null || ownerUid !== procCtx.uid) return false
  }
  if (!/node|tsx/i.test(cmd)) return false
  const matches = procCtx.listOwnProcessesMatching(DASHBOARD_BINARY_PATTERN)
  return matches.includes(pid)
}

function buildPidfileLockContext(procCtx: ProcessLockContext): PidfileLockContext {
  return {
    tryCreateExclusive(path, pid) {
      try {
        const fd = openSync(path, 'wx')
        try {
          // Short-writes can legally return fewer bytes than requested.
          // writeBufferFully loops until the buffer is fully drained; if
          // we crash mid-write the file is left truncated and
          // readRecordedPidFrom will reject it as non-digits.
          writeBufferFully(
            (b, off, len) => writeSync(fd, b, off, len),
            Buffer.from(String(pid)),
          )
        } finally {
          closeSync(fd)
        }
        return 'created'
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists'
        throw err
      }
    },
    readRecordedPid(path) {
      return readRecordedPidFrom(path)
    },
    unlinkIfMatches(path, expected) {
      // Re-read just before unlink so a third party's freshly-won lock
      // (O_EXCL'd after our SIGTERM'd predecessor exited) survives. Not
      // atomic w.r.t. an interleaved rewrite: if the file is rewritten
      // between our read and the unlink, we could still delete the new
      // file. The winning side's openSync('wx') is atomic, so the worst
      // case is a spurious removal plus one more acquire-loop iteration,
      // not a double-acquire.
      try {
        const raw = readFileSync(path, 'utf-8').trim()
        const current: number | null = /^\d+$/.test(raw) ? parseInt(raw, 10) : null
        if (current !== expected) return
        unlinkSync(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
        throw err
      }
    },
    probeAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ESRCH') return false
        // Non-ESRCH: rethrow so the caller is conservative (assumes alive).
        throw err
      }
    },
    sendTerm(pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ESRCH') return
        throw err
      }
    },
    isLegitimatePredecessor(pid) {
      return isLegitimateDashboardPid(pid, procCtx)
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
    log: {
      info: (obj, msg) => logger.info(obj, msg),
      warn: (obj, msg) => logger.warn(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    },
  }
}

// Fresh-startup race short-circuit. When two dashboard processes start
// near-simultaneously, acquirePortLock would see the loser's peer as a
// zombie (alive + binary-pattern match, but not yet listening on the port)
// and SIGKILL it before the peer ever got a chance to install its signal
// handlers. That's exactly the "startup race kills the winner mid-init"
// scenario. Check the pidfile FIRST: if it already records a legitimate
// alive peer that isn't listening on the port yet, the peer is mid-init
// and we're the loser -- defer.
function checkFreshStartupRace(procCtx: ProcessLockContext): void {
  const recorded = readRecordedPidFrom(PID_FILE)
  if (recorded == null || recorded === process.pid) return

  let alive = false
  try {
    const out = procCtx.signal(recorded, 0)
    alive = out === 'sent'
  } catch {
    // Probe failed (e.g. EPERM). We cannot positively detect the race, so
    // we fall through to acquirePortLock which will SIGTERM the matching
    // binary-pattern process. That peer's early signal handler (installed
    // before acquireLock in main) runs graceful shutdown, so even if the
    // peer was mid-init the state is flushed cleanly rather than lost.
    return
  }
  if (!alive) return

  if (!isLegitimateDashboardPid(recorded, procCtx)) return

  // If the peer already holds the listening port, it's a fully-up
  // predecessor (not a mid-init winner). acquirePortLock will handle it.
  const portHolders = procCtx.listPortHolders(WEB_PORT)
  if (portHolders.includes(recorded)) return

  throw new DeferToPeerError(recorded)
}

async function acquireLock(): Promise<void> {
  mkdirSync(STORE_DIR, { recursive: true })

  const procCtx = buildProcessLockContext()

  // Defer BEFORE we start killing things: if the pidfile records a peer
  // that is alive, legitimate, and not yet on the port, we're the loser
  // of a fresh-startup race -- exit 0 without disturbing the winner.
  checkFreshStartupRace(procCtx)

  // Kill any previous instance(s) next: anything holding WEB_PORT, and
  // anything running the dashboard binary (for the zombie case where the
  // port was released but the process survived). The pidfile alone can
  // lie under launchd KeepAlive because each restart overwrites it.
  await acquirePortLock(WEB_PORT, procCtx, { binaryPattern: DASHBOARD_BINARY_PATTERN })

  // Atomic O_EXCL claim on PID_FILE. Serializes any two fresh startups
  // that race past the port check. `onLiveLegitimate: 'defer'` is a
  // belt-and-braces backup -- checkFreshStartupRace above should have
  // already caught the common case, but if the winner wrote its pidfile
  // between those two checks, defer here too.
  await acquirePidfileLock(PID_FILE, process.pid, buildPidfileLockContext(procCtx), {
    onLiveLegitimate: 'defer',
  })
}

// Delete the PID file ONLY if it still points at this process. A zombie
// shutdown path must not nuke the successor's pidfile after the successor
// already overwrote it.
function releaseLock(): void {
  try {
    const recordedPid = readRecordedPidFrom(PID_FILE)
    if (recordedPid !== process.pid) return
    unlinkSync(PID_FILE)
  } catch {
    // best-effort: the pidfile may already be gone (successor unlinked it)
  }
}

// Module-scope runtime state + shutdown hook. Kept out of main() so the
// main().catch handler can reach shutdown when an async init step rejects
// after partial state was already wired up (e.g. initDatabase throws after
// acquireLock wrote the pidfile -- we still need to drop the heartbeat /
// digest timers and release the pidfile on the way out).
let decayInterval: NodeJS.Timeout | null = null
let digestTimer: NodeJS.Timeout | null = null
let digestInterval: NodeJS.Timeout | null = null
let heartbeatStarted = false
let webServer: HttpServer | null = null
let shuttingDown = false
let exitCode = 0

const shutdown = (): void => {
  if (shuttingDown) return
  try {
    shuttingDown = true
    logger.info('Leallitas...')
    if (heartbeatStarted) {
      try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }
    }
    if (decayInterval) clearInterval(decayInterval)
    if (digestTimer) clearTimeout(digestTimer)
    if (digestInterval) clearInterval(digestInterval)

    const hardKill = setTimeout(() => {
      logger.warn({ timeoutMs: SHUTDOWN_HARD_KILL_MS }, 'Graceful shutdown timeout, hard exit')
      releaseLock()
      process.exit(exitCode || 1)
    }, SHUTDOWN_HARD_KILL_MS)

    if (webServer) {
      try { webServer.closeIdleConnections?.() } catch { /* older node */ }
      try { webServer.closeAllConnections?.() } catch { /* older node */ }
      webServer.close(() => {
        clearTimeout(hardKill)
        releaseLock()
        process.exit(exitCode)
      })
    } else {
      // Early shutdown, before startWebServer ran. Nothing to drain.
      clearTimeout(hardKill)
      releaseLock()
      process.exit(exitCode)
    }
  } catch (err) {
    logger.error({ err }, 'Shutdown threw, exiting anyway')
    releaseLock()
    process.exit(1)
  }
}

async function main(): Promise<void> {
  console.log(BANNER)

  // Install signal handlers EARLIEST so we can respond cleanly to SIGTERM
  // during init. Required to close the fresh-startup race: a concurrent
  // startup will SIGTERM this process via acquirePortLock's binary-pattern
  // kill; without an early handler, default SIGTERM behavior terminates
  // us mid-init with no chance to flush SQLite WAL or drop the pidfile.
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException')
    exitCode = 1
    shutdown()
  })
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection')
  })

  await acquireLock()

  // Database
  initDatabase()
  logger.info('Adatbazis inicializalva')

  // Memory decay (24h cycle)
  runDecaySweep()
  decayInterval = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)
  logger.info('Memoria leepulesi ciklus beallitva (24 oras)')

  // Daily digest at 23:00. Timer handles kept so shutdown can drop them.
  function scheduleDailyDigest() {
    const now = new Date()
    const target = new Date(now)
    target.setHours(23, 0, 0, 0)
    if (target <= now) target.setDate(target.getDate() + 1)
    const msUntil = target.getTime() - now.getTime()
    digestTimer = setTimeout(() => {
      runDailyDigest(ALLOWED_CHAT_ID).catch((err) =>
        logger.error({ err }, 'Napi naplo hiba')
      )
      digestInterval = setInterval(() => {
        runDailyDigest(ALLOWED_CHAT_ID).catch((err) =>
          logger.error({ err }, 'Napi naplo hiba')
        )
      }, 24 * 60 * 60 * 1000)
    }, msUntil)
    logger.info({ nextRun: target.toLocaleString('hu-HU') }, 'Napi naplo utemezve')
  }
  scheduleDailyDigest()

  // Heartbeat
  initHeartbeat()
  heartbeatStarted = true
  logger.info('Heartbeat utemezo elindult')

  // Web dashboard
  webServer = startWebServer(WEB_PORT)

  logger.info(`ClaudeClaw Lite fut! Dashboard: http://localhost:${WEB_PORT}`)
  logger.info('Telegram kommunikacio: Claude Code Channels kezeli')
}

main().catch((err) => {
  if (err instanceof DeferToPeerError) {
    logger.info({ peerPid: err.peerPid }, 'Peer dashboard already claimed the pidfile, exiting quietly')
    process.exit(0)
  }
  // Route through shutdown() so any partial init (heartbeat, digest
  // timers, decay interval) is drained before exit. shutdown() is
  // idempotent and no-ops if a signal handler already ran; in that case
  // we must NOT overwrite the exit code the handler already chose --
  // otherwise a clean SIGTERM plus a concurrent unrelated async rejection
  // would report crash when the operator expected 0.
  logger.error({ err }, 'Vegzetes hiba')
  if (!shuttingDown) exitCode = 1
  shutdown()
})
