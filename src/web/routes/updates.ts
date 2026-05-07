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
import type { RouteContext } from './types.js'

// Pidfile path owned by update.sh for the lifetime of an update run.
// The dashboard never writes it -- update.sh does on entry, removes on exit
// via a trap -- so the gate survives the stop.sh / start.sh dashboard
// restart that happens inside a successful update.
const UPDATE_PIDFILE = join(PROJECT_ROOT, 'store', 'update.pid')

export async function tryHandleUpdates(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/updates' && method === 'GET') {
    json(res, getUpdateStatus())
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
      // update.sh handle the stash+pop. Other failure reasons (detached HEAD,
      // not-on-main, …) still hard-block since stash cannot rescue them.
      const skipForAutoStash = preflight.reason === 'dirty-tree' && autoStash
      if (!skipForAutoStash) {
        releaseLock()
        const body: Record<string, unknown> = {
          error: preflight.message,
          reason: preflight.reason,
        }
        if (preflight.reason === 'not-on-main') body.branch = preflight.branch
        json(res, body, 409)
        return true
      }
    }
    try {
      let outFd: number | 'ignore' = 'ignore'
      try {
        mkdirSync(STORE_DIR, { recursive: true })
        outFd = openSync(join(STORE_DIR, 'update.log'), 'a', 0o600)
      } catch (err) {
        logger.warn({ err }, 'Could not open update.log for update.sh stdio; falling back to ignore')
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
