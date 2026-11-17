import {
  readFileSync, writeFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { readConflictGuard } from '../../update-conflict-guard.js'
import { logger } from '../../logger.js'
import { generatedDriftPaths, runInstallDriftRepair, withoutGeneratedDrift } from '../../install-drift-repair.js'
import {
  getUpdateStatus, refreshUpdateStatus,
} from '../update-checker.js'
import {
  checkUpdatePreflight, checkNoConcurrentUpdate, classifyLockWriteError,
  type GitRunner, type PidfileRunner,
} from '../../update-preflight.js'
import { json, readBody, readBodyOrRefuse } from '../http-helpers.js'
import { claudeAgentRunnable } from '../../update-agent-capability.js'
import { runScheduledTaskNow } from '../schedule-runner.js'
import { buildCliUpdateStatus, cliUpdateDepsForRoute, startCliUpdate, VERSION_RE } from '../cli-update.js'
import type { RouteContext } from './types.js'
import { mayActAsOwner, ownerCookieSession, refuseOwner } from './auth.js'
import { computeTimeoutAt } from './approvals.js'
import { createApproval, getApproval, resolveApproval } from '../../db.js'
import { computeRebasePlan, UPDATE_REBASE_CATEGORY, UPDATE_REBASE_WINDOW_S, type PlanGitRunner } from '../../update-rebase-plan.js'
import { randomUUID } from 'node:crypto'
import { deployment, MANAGED_BY_IMAGE } from '../deployment.js'

const execFileAsync = promisify(execFile)

// git for the update pre-check, off the event loop (ls-remote is a network call
// with a 15 s timeout). stdin is closed at once, as the synchronous calls did.
async function gitOut(args: string[], timeout: number): Promise<string> {
  const pending = execFileAsync('/usr/bin/git', args, { cwd: PROJECT_ROOT, timeout, encoding: 'utf-8' })
  pending.child.stdin?.end()
  const { stdout } = await pending
  return stdout
}

// trackedBranch() (update-checker.ts) runs git synchronously; the pre-check
// needs the same answer without blocking the event loop.
async function trackedBranchAsync(): Promise<string> {
  try {
    const b = (await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], 3000)).trim()
    return b && b !== 'HEAD' ? b : 'main'
  } catch {
    return 'main'
  }
}

// AUTOUPDATEDIVERG1110 2nd PR: the read-only plan of an owner-approved rebase (src/update-rebase-plan.ts).
const planGit: PlanGitRunner = {
  out: (args, timeoutMs) => gitOut(args, timeoutMs),
  fetchAgeS: () => {
    try { return Math.max(0, Math.round((Date.now() - statSync(join(PROJECT_ROOT, '.git', 'FETCH_HEAD')).mtimeMs) / 1000)) } catch { return null }
  },
}
const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The apply-time check of a rebase approval. NOT a consume (update.sh's clean process consumes it, once, right
// before the rebase, against the commit its own fetch brought): this only makes a stale or wrong approval fail
// here, at once and readably, instead of after the run has started.
async function checkRebaseApproval(id: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const a = getApproval(id)
  if (!a || a.category !== UPDATE_REBASE_CATEGORY) return { ok: false, reason: 'rebase-approval-not-found', message: 'No update_rebase approval with this id.' }
  if (a.status !== 'approved') return { ok: false, reason: 'rebase-approval-not-approved', message: 'The owner has not approved this update yet.' }
  if (a.consumed_at != null) return { ok: false, reason: 'rebase-approval-used', message: 'This approval was already used; ask for a new one.' }
  const nowS = Math.floor(Date.now() / 1000)
  if (!a.resolved_at || nowS - a.resolved_at > UPDATE_REBASE_WINDOW_S) {
    return { ok: false, reason: 'rebase-approval-expired', message: 'The approval is older than 30 minutes; ask for a new one.' }
  }
  const r = await computeRebasePlan(planGit)
  if (!r.ok) return { ok: false, reason: 'rebase-plan-unavailable', message: `The update plan cannot be computed (${r.reason}).` }
  if (r.plan.willFail) return { ok: false, reason: 'rebase-will-fail', message: `This update would fail for sure (${r.plan.willFail}).` }
  if (r.plan.hash !== a.content_hash) {
    return { ok: false, reason: 'rebase-plan-changed', message: 'The plan changed since the approval (a new local or upstream commit); look at it again and approve the new one.' }
  }
  return { ok: true }
}

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
  const { res, req, path, method } = ctx

  // HOSTINGERDOCKER1107: in the container the image owns the version: no update.sh and no CLI install from here.
  if (method === 'POST' && (path === '/api/updates/apply' || path === '/api/updates/cli/apply') && deployment() === 'docker') {
    json(res, MANAGED_BY_IMAGE, 409)
    return true
  }

  if (path === '/api/updates' && method === 'GET') {
    // UPDATECONFLICT1105: what start.sh's conflict guard found after the last update (null when nothing).
    json(res, { ...getUpdateStatus(), conflictGuard: readConflictGuard(STORE_DIR), deployment: deployment() })
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
    const fired = await runScheduledTaskNow(DIAGNOSE_TASK, { allowDisabled: true })
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

  // Claude Code CLI update OFFER (CLIFRISSAJANLAS923). GET measures; nothing
  // is installed until the operator POSTs the exact target the GET offered.
  if (path === '/api/updates/cli' && method === 'GET') {
    json(res, { ...(await buildCliUpdateStatus(cliUpdateDepsForRoute({ fresh: ctx.url.searchParams.get('fresh') === '1' }))), deployment: deployment() })
    return true
  }
  if (path === '/api/updates/cli/apply' && method === 'POST') {
    const body = String(await readBody(req).catch(() => '') ?? '')
    let requested = ''
    try { requested = String((JSON.parse(body || '{}') as { target?: unknown }).target ?? '') } catch { requested = '' }
    if (!VERSION_RE.test(requested)) { json(res, { error: 'target must be a dotted version', reason: 'bad-target' }, 400); return true }
    // Re-decide fresh: the only installable version is the one the offer
    // computes NOW (an AVX-less host can never be handed "latest" this way).
    const status = await buildCliUpdateStatus(cliUpdateDepsForRoute({ fresh: true }))
    if (!status.offer || status.target !== requested) {
      json(res, { error: `not offered: ${status.reason}`, reason: 'not-offered', target: status.target, offer: status.offer }, 409)
      return true
    }
    if (status.installMethod === 'unknown') {
      json(res, { error: 'the installed claude was not installed by npm or the official installer; run the manual command instead', reason: 'unknown-method', manualCommand: status.manualCommand }, 400)
      return true
    }
    const started = startCliUpdate(status.target, status.installMethod)
    if (!started.ok) { json(res, { error: started.error, reason: 'not-started' }, 409); return true }
    json(res, { ok: true, started: true, target: status.target, method: status.installMethod })
    return true
  }

  if (path === '/api/updates/check' && method === 'POST') {
    const status = await refreshUpdateStatus()
    json(res, status)
    return true
  }

  // AUTOUPDATEDIVERG1110 2nd PR, Dani F3: READ-ONLY. No fetch, no ref write (ls-remote reads the remote).
  // The agent reads it to file its update_rebase request with this hash; the dialog shows it to the owner.
  if (path === '/api/updates/rebase-plan' && method === 'GET') {
    const r = await computeRebasePlan(planGit)
    json(res, r.ok ? r.plan : { error: r.reason }, r.ok ? 200 : 409)
    return true
  }

  // Dani F2: the owner approves what the dialog SHOWED. The dialog sends back the plan's hash; the server
  // recomputes the plan now and refuses (409 plan_changed) when it differs. Owner only; the row is created AND
  // approved by the owner's session in one step, and says so (agent_id and resolved_by both "owner:<user>").
  if (path === '/api/updates/rebase-approve' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      refuseOwner(res, 'Approving an update that replays local changes needs the dashboard login (an owner session).')
      return true
    }
    const buf = await readBodyOrRefuse(ctx.req, res)
    if (!buf) return true
    let hash: unknown
    try { hash = (JSON.parse(buf.toString()) as { hash?: unknown }).hash } catch { /* checked below */ }
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      json(res, { error: 'hash must be the 64-char hex hash of the plan the dialog showed', reason: 'bad-hash' }, 400)
      return true
    }
    const r = await computeRebasePlan(planGit)
    if (!r.ok) { json(res, { error: `The update plan cannot be computed (${r.reason}).`, reason: 'rebase-plan-unavailable' }, 409); return true }
    if (!r.plan.diverged) { json(res, { error: 'There is nothing to replay: the install is not diverged.', reason: 'not-diverged' }, 409); return true }
    if (r.plan.willFail) { json(res, { error: `This update would fail for sure (${r.plan.willFail}).`, reason: 'rebase-will-fail' }, 409); return true }
    if (r.plan.hash !== hash) {
      json(res, { error: 'The plan changed since the dialog opened; look at it again.', reason: 'plan_changed', plan: r.plan }, 409)
      return true
    }
    const owner = (ctx.auth?.kind === 'session' ? ctx.auth.user : null) ?? ownerCookieSession(req) ?? 'owner'
    const id = randomUUID()
    createApproval({
      id,
      agent_id: `owner:${owner}`,
      category: UPDATE_REBASE_CATEGORY,
      action_description: `Update with ${r.plan.ahead} local commit(s) replayed onto ${r.plan.target.slice(0, 12)} (approved by the owner in the dashboard update dialog, one step)`,
      action_payload: JSON.stringify({ branch: r.plan.branch, head: r.plan.head, target: r.plan.target, commits: r.plan.commits.map((c) => c.sha) }),
      timeout_at: computeTimeoutAt(UPDATE_REBASE_CATEGORY, UPDATE_REBASE_WINDOW_S),
      content_hash: r.plan.hash,
    })
    resolveApproval(id, 'approved', `owner:${owner}`)
    logger.info({ id, owner, head: r.plan.head, target: r.plan.target, ahead: r.plan.ahead }, 'update_rebase approved by the owner in one step')
    json(res, { id, hash: r.plan.hash, windowS: UPDATE_REBASE_WINDOW_S }, 201)
    return true
  }

  if (path === '/api/updates/apply' && method === 'POST') {
    // Optional body { autoStash: true } turns the dirty-tree precheck
    // failure into a managed stash + pop pattern inside update.sh.
    // Without it, a dirty working tree returns 409 'dirty-tree' as before.
    let autoStash = false
    // AUTOUPDATEDIVERG1110 2nd PR: the owner's update_rebase approval for a diverged install (its id).
    let rebaseApproval: unknown
    // A body cut off mid-way is refused, not read as "no autoStash".
    const buf = await readBodyOrRefuse(ctx.req, res)
    if (!buf) return true
    try {
      if (buf.length > 0) {
        const parsed = JSON.parse(buf.toString()) as { autoStash?: unknown; rebaseApproval?: unknown }
        autoStash = parsed.autoStash === true
        if (parsed.rebaseApproval !== undefined) rebaseApproval = parsed.rebaseApproval
      }
    } catch {
      // Empty/invalid body: treat as autoStash=false. Real validation lives
      // at update.sh's own dirty-tree check; this is just a hint.
    }
    // OWNEREXEC1109: autoStash lets the update stash local changes to the install and, when the pop conflicts, leave
    // them behind; that is the owner's call. A plain apply (no body, as the operator surface forwards it) is unchanged.
    if (rebaseApproval !== undefined) {
      if (typeof rebaseApproval !== 'string' || !APPROVAL_ID_RE.test(rebaseApproval)) {
        json(res, { error: 'rebaseApproval must be an approval id', reason: 'bad-approval-id' }, 400)
        return true
      }
      const ok = await checkRebaseApproval(rebaseApproval)
      if (!ok.ok) { json(res, { error: ok.message, reason: ok.reason }, 409); return true }
    }
    if (autoStash && !mayActAsOwner(ctx.auth, req)) {
      refuseOwner(res, 'An update that stashes local changes needs the dashboard login (an owner session).')
      return true
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
    const countRevs = async (range: string): Promise<number> => {
      try {
        const out = (await gitOut(['rev-list', '--count', range], 3000)).trim()
        const n = parseInt(out, 10)
        return Number.isFinite(n) ? n : 0
      } catch { return 0 }
    }
    const git: GitRunner = {
      currentBranch: () => gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], 3000),
      porcelainStatus: () => gitOut(['status', '--porcelain', '--untracked-files=no'], 3000),
      // UPSTREAMSRC927: origin/<branch>, the ref update.sh pulls -- not `@{u}`,
      // which is whatever the branch happens to track. No fetch here (this is
      // the request path); the ref can be stale, which is why update.sh fetches
      // and measures again before its own divergence check.
      aheadCount: async () => countRevs(`origin/${await trackedBranchAsync()}..HEAD`),
      behindCount: async () => countRevs(`HEAD..origin/${await trackedBranchAsync()}`),
      // Mirrors update.sh guard 2. `git ls-remote --exit-code --heads` exits
      // 2 for "no such branch" and 128 for a transport/auth failure -- the
      // difference matters: only 2 is evidence, 128 is an unknown we must not
      // block on. A spawn failure or a timeout leaves no numeric exit code,
      // which is likewise unknown.
      originHasBranch: async (branch: string) => {
        try {
          await gitOut(['ls-remote', '--exit-code', '--heads', 'origin', branch], 15000)
          return 'yes' as const
        } catch (err) {
          // execFile reports git's exit status as err.code (a number); a spawn
          // failure or a timeout leaves no numeric code -- unknown, as before.
          const code = (err as { code?: unknown }).code
          return code === 2 ? ('no' as const) : ('unknown' as const)
        }
      },
    }
    // INSTALLDIRTYTREE1103: the install's own tracked-file drift must not block the
    // update (or send it down the stash path). The dashboard only ASKS (dry run,
    // no file written while the services run -- Samu 67345 (A)); the preflight
    // ignores exactly those paths, and update.sh restores them before its own
    // dirty guard, in the run that ends with a restart.
    const drift = await runInstallDriftRepair(PROJECT_ROOT, undefined, { dryRun: true })
    if (drift.results.length > 0 || drift.error) logger.info({ drift }, 'install-drift-repair dry run before the update preflight')
    const generated = generatedDriftPaths(drift)
    const preflightGit: GitRunner = generated.size === 0 ? git : {
      ...git,
      porcelainStatus: async () => withoutGeneratedDrift(await git.porcelainStatus(), generated),
    }
    let preflight
    try {
      preflight = await checkUpdatePreflight(preflightGit)
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
      // A diverged install with a valid owner approval (checked above): update.sh replays the local commits.
      const skipForRebase = preflight.reason === 'local-commits' && typeof rebaseApproval === 'string'
      if (!skipForAutoStash && !skipForRebase) {
        releaseLock()
        const body: Record<string, unknown> = {
          error: preflight.message,
          reason: preflight.reason,
        }
        // Samu 74881 point 8: the local-commits refusal is not a dead end -- the dashboard opens the
        // approval dialog from this, and an agent learns where to read the plan.
        if (preflight.reason === 'local-commits') body.rebasePlan = '/api/updates/rebase-plan'
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
      // NODE_ENV must not reach update.sh: with NODE_ENV=production npm defaults
      // to omit=dev, the pruned tree loses tsc, and every update build fails and
      // rolls back forever (AUTOUPDNODEENV905). Deleting it here shields the
      // OLD update.sh copies already deployed at customers, which lack the
      // script-side --include=dev fix and can only receive it through a run
      // this spawn starts.
      const updateEnv: NodeJS.ProcessEnv = { ...process.env, AUTO_STASH: autoStash ? '1' : '0' }
      delete updateEnv['NODE_ENV']
      // Dani F1: nothing from the dashboard's own environment steers the rebase. The approval id is the only
      // input, and only from this request; the consume itself runs in update.sh's env -i process.
      delete updateEnv['UPDATE_AUTO_REBASE']
      delete updateEnv['UPDATE_REBASE_APPROVAL']
      if (typeof rebaseApproval === 'string') updateEnv['UPDATE_REBASE_APPROVAL'] = rebaseApproval
      const child = spawn('/bin/bash', [join(PROJECT_ROOT, 'update.sh')], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: updateEnv,
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
