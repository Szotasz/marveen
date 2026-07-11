import {
  readFileSync, writeFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import {
  getUpdateStatus, refreshUpdateStatus,
} from '../update-checker.js'
import {
  checkUpdatePreflight, checkNoConcurrentUpdate, classifyLockWriteError,
  type GitRunner, type PidfileRunner,
} from '../../update-preflight.js'
import { json, readBody } from '../http-helpers.js'
import { claudeAgentRunnable } from '../../update-agent-capability.js'
import { runScheduledTaskNow } from '../schedule-runner.js'
import type { RouteContext } from './types.js'

// Pidfile path owned by update.sh for the lifetime of an update run.
// The dashboard never writes it -- update.sh does on entry, removes on exit
// via a trap -- so the gate survives the stop.sh / start.sh dashboard
// restart that happens inside a successful update.
const UPDATE_PIDFILE = join(PROJECT_ROOT, 'store', 'update.pid')

// The seeded on-demand (enabled:false) task the post-rollback diagnosis fires.
const DIAGNOSE_TASK = 'post-rollback-diagnose'
// One-diagnosis-per-rollback marker (keyed by the last-result timestamp).
const DIAGNOSE_MARKER = join(PROJECT_ROOT, 'store', 'update-diagnose.last')

type LastResult = { status?: string; ts?: number; phase?: string; message?: string }
function readLastResult(): LastResult | null {
  try { return JSON.parse(readFileSync(join(STORE_DIR, 'update.last-result'), 'utf-8')) as LastResult }
  catch { return null }
}
// A post-rollback diagnosis is meaningful only after a terminal FAILED /
// ROLLED-BACK outcome (a success or an in-progress run is not diagnosable).
function isDiagnosable(r: LastResult | null): boolean {
  return r?.status === 'rolled-back' || r?.status === 'failed'
}

export async function tryHandleUpdates(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/updates' && method === 'GET') {
    json(res, getUpdateStatus())
    return true
  }

  // Real outcome of the last (or in-flight) update.sh run. update.sh writes
  // store/update.last-result on EXIT with the true status, so the frontend can
  // show success/failed/rolled-back instead of a blind reload that hides a
  // silent failure. Absent file => no run yet (or one still in progress; the
  // presence of store/update.pid disambiguates).
  if (path === '/api/updates/status' && method === 'GET') {
    const result = readLastResult()
    let running = false
    try { running = statSync(UPDATE_PIDFILE).isFile() } catch { /* not running */ }
    // Post-rollback diagnosis offer (PR-D). Offer the opt-in fixer only when the
    // last update FAILED/ROLLED-BACK *and* this host can actually run a Claude
    // agent. On an AVX-less host (agent cannot start) we flag needsHuman so the
    // UI shows a "manual intervention" note instead of a dead-end button.
    const diagnosable = isDiagnosable(result)
    const claudeRunnable = claudeAgentRunnable()
    json(res, {
      running,
      result,
      canDiagnose: diagnosable && claudeRunnable && !running,
      needsHuman: diagnosable && !claudeRunnable,
    })
    return true
  }

  // Opt-in post-rollback diagnosis (PR-D). The operator explicitly requests it
  // from the dashboard (credit consent handled in the UI). Fires the seeded,
  // guardrailed post-rollback-diagnose task at the main agent. Guarded so it is
  // only reachable in a genuine rollback state and never on a host that cannot
  // run the agent.
  if (path === '/api/updates/diagnose' && method === 'POST') {
    const result = readLastResult()
    if (!isDiagnosable(result)) {
      json(res, { error: 'No failed or rolled-back update to diagnose.', reason: 'no-rollback' }, 409)
      return true
    }
    if (!claudeAgentRunnable()) {
      json(res, {
        error: 'This host cannot run a Claude agent (CPU lacks AVX), so auto-diagnosis is unavailable. Manual intervention needed.',
        reason: 'claude-unrunnable',
      }, 400)
      return true
    }
    // Idempotency: one diagnosis per rollback, keyed by the outcome timestamp,
    // so a double-click (or a re-poll) does not spawn a second agent.
    const key = String(result?.ts ?? '')
    try {
      if (key && readFileSync(DIAGNOSE_MARKER, 'utf-8').trim() === key) {
        json(res, { ok: true, already: true })
        return true
      }
    } catch { /* no marker yet */ }
    const fired = runScheduledTaskNow(DIAGNOSE_TASK, { allowDisabled: true })
    if (!fired.ok) {
      logger.warn({ err: fired.error }, 'post-rollback diagnosis could not be fired')
      json(res, { error: fired.error || 'Could not start the diagnosis agent.', reason: 'fire-failed' }, 500)
      return true
    }
    try { writeFileSync(DIAGNOSE_MARKER, key, { mode: 0o600 }) } catch { /* best-effort */ }
    logger.info({ result: fired.result }, 'post-rollback diagnosis fired')
    json(res, { ok: true, result: fired.result })
    return true
  }

  if (path === '/api/updates/check' && method === 'POST') {
    const status = await refreshUpdateStatus()
    json(res, status)
    return true
  }

  if (path === '/api/updates/apply' && method === 'POST') {
    // Optional body { autoStash: true } turns the dirty-tree precheck
    // failure into a managed stash + pop pattern inside update.sh.
    // Without it, a dirty working tree returns 409 'dirty-tree' as before.
    let autoStash = false
    try {
      const buf = await readBody(ctx.req)
      if (buf.length > 0) {
        const parsed = JSON.parse(buf.toString()) as { autoStash?: unknown }
        autoStash = parsed.autoStash === true
      }
    } catch {
      // Empty/invalid body: treat as autoStash=false. Real validation lives
      // at update.sh's own dirty-tree check; this is just a hint.
    }
    const pf: PidfileRunner = {
      readPidfile: () => {
        try {
          const st = statSync(UPDATE_PIDFILE)
          if (!st.isFile() || st.size > 256) return null
          return readFileSync(UPDATE_PIDFILE, 'utf-8')
        } catch {
          return null
        }
      },
      isProcessAlive: (pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (err) {
          return (err as NodeJS.ErrnoException)?.code === 'EPERM'
        }
      },
      now: () => Date.now(),
    }
    const pidfileContent = `${process.pid}\n${Date.now()}\n`
    let lockHeld = false
    try {
      writeFileSync(UPDATE_PIDFILE, pidfileContent, { flag: 'wx' })
      lockHeld = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        json(res, {
          error: 'Pidfile write failed: ' + (err instanceof Error ? err.message : String(err)),
          reason: 'lock-write-failed',
        }, 500)
        return true
      }
      const concurrency = checkNoConcurrentUpdate(pf)
      if (!concurrency.ok) {
        json(res, {
          error: concurrency.message,
          reason: concurrency.reason,
          pid: concurrency.pid,
        }, 409)
        return true
      }
      try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
      try {
        writeFileSync(UPDATE_PIDFILE, pidfileContent, { flag: 'wx' })
        lockHeld = true
      } catch (retryErr) {
        const code = (retryErr as NodeJS.ErrnoException)?.code
        if (classifyLockWriteError(code) === 'race') {
          json(res, {
            error: 'Another update is starting concurrently. Retry in a few seconds.',
            reason: 'already-running',
            pid: 0,
          }, 409)
          return true
        }
        json(res, {
          error: 'Pidfile retry-write failed: ' + (retryErr instanceof Error ? retryErr.message : String(retryErr)),
          reason: 'lock-write-failed',
        }, 500)
        return true
      }
    }
    const releaseLock = () => {
      if (!lockHeld) return
      try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
      lockHeld = false
    }
    const git: GitRunner = {
      currentBranch: () => execFileSync(
        '/usr/bin/git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
      ),
      porcelainStatus: () => execFileSync(
        '/usr/bin/git',
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
      ),
      aheadCount: () => {
        try {
          const out = execFileSync(
            '/usr/bin/git',
            ['rev-list', '--count', '@{u}..HEAD'],
            { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
          ).trim()
          const n = parseInt(out, 10)
          return Number.isFinite(n) ? n : 0
        } catch { return 0 }
      },
    }
    let preflight
    try {
      preflight = checkUpdatePreflight(git)
    } catch (err) {
      releaseLock()
      json(res, {
        error: 'Pre-check failed: ' + (err instanceof Error ? err.message : String(err)),
        reason: 'precheck-crashed',
      }, 500)
      return true
    }
    if (!preflight.ok) {
      // dirty-tree + autoStash=true: skip the dashboard-side block and let
      // update.sh handle the stash+pop. The other failure reason (detached
      // HEAD) still hard-blocks since stash cannot rescue it.
      // dirty-tree can be auto-stashed; local-commits and detached-head cannot.
      const skipForAutoStash = preflight.reason === 'dirty-tree' && autoStash
      if (!skipForAutoStash) {
        releaseLock()
        const body: Record<string, unknown> = {
          error: preflight.message,
          reason: preflight.reason,
        }
        json(res, body, 409)
        return true
      }
    }
    try {
      // Verify store/ is writable BEFORE spawning update.sh. If update.log
      // cannot be opened, the script would die at its own exit-4 with the log
      // (its only output channel) being the very thing that failed -> a silent
      // detached death. Surface it here as a synchronous error instead.
      let outFd: number | 'ignore' = 'ignore'
      try {
        mkdirSync(STORE_DIR, { recursive: true })
        outFd = openSync(join(STORE_DIR, 'update.log'), 'a', 0o600)
      } catch (err) {
        releaseLock()
        logger.error({ err }, 'store/update.log not writable; refusing to start a blind update')
        json(res, { error: 'store/ is not writable; cannot run the updater safely.', reason: 'store-unwritable' }, 500)
        return true
      }
      const child = spawn('/bin/bash', [join(PROJECT_ROOT, 'update.sh')], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: { ...process.env, AUTO_STASH: autoStash ? '1' : '0' },
      })
      child.on('error', (err) => {
        logger.error({ err }, 'update.sh spawn reported an async error')
        let stillOurs = false
        try {
          stillOurs = readFileSync(UPDATE_PIDFILE, 'utf-8') === pidfileContent
        } catch { /* file already gone -- nothing to release */ }
        if (stillOurs) releaseLock()
      })
      child.unref()
      if (typeof outFd === 'number') {
        try { closeSync(outFd) } catch { /* already closed */ }
      }
      json(res, { ok: true })
    } catch (err) {
      releaseLock()
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  return false
}
