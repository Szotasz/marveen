// Preflight check for the in-dashboard "Update now" button.
//
// The previous flow was:
//   1. user clicks "Frissítés most"
//   2. backend spawns update.sh (detached, stdio ignored)
//   3. frontend receives { ok: true }, shows "Frissítés elindult..."
//   4. after 30s the page reloads and shows the same pending commits
//
// The silent failure mode is update.sh hitting `git pull --ff-only origin
// <branch>` while the local checkout is detached, or has local
// modifications that would make a fast-forward impossible. set -e in
// update.sh makes it exit before the stop.sh / start.sh step, but the
// frontend has no way to know because it only watched spawn() success.
//
// The update is branch-agnostic: update.sh derives the branch from the
// current checkout and pulls origin/<that-branch>, so an install that
// tracks any release branch (main, develop, …) self-updates. The only
// branch state this preflight rejects is a detached HEAD, which has no
// branch to pull.
//
// Running the preflight checks server-side means the apply endpoint can
// refuse with a 409 and a readable reason, the user sees an actionable
// toast, and the dashboard never enters the "reload in 30s" lie for a
// run that was guaranteed to fail.
//
// The module takes its git calls through a GitRunner interface so the
// decision logic is pure and synchronously testable without shelling
// out in tests.

export interface GitRunner {
  // Current branch name. "HEAD" (or empty) signals a detached checkout.
  currentBranch(): string
  // Number of local commits ahead of the upstream tracking ref
  // (git rev-list --count @{u}..HEAD). Returns 0 when there is no upstream
  // or the probe fails (the safe default: do not block on an uncertain
  // count -- the branch-on-origin probe below catches the no-upstream case
  // on its own terms).
  aheadCount(): number
  // Number of upstream commits the local checkout is missing
  // (git rev-list --count HEAD..@{u}), same failure convention as above.
  // Ahead ALONE is not a divergence: there is simply nothing to
  // fast-forward to, and update.sh proceeds. Only ahead AND behind
  // together mean the histories parted and ff-only must refuse.
  behindCount(): number
  // Does the branch exist on the `origin` remote? update.sh pulls
  // origin/<branch> and exits 2 when that ref does not exist, so a
  // local-only branch is a guaranteed-failed run. Network probe, hence
  // three-valued: 'unknown' (offline, auth failure, timeout) must NOT
  // block -- an uncertain probe is not evidence of a missing branch.
  originHasBranch(branch: string): 'yes' | 'no' | 'unknown'
  // Porcelain status excluding untracked files. Non-empty = dirty tree.
  // Untracked files are excluded because the repo legitimately carries
  // ad-hoc backup files (CLAUDE.md.backup-*, SOUL.md mid-edit, etc.)
  // that should not block an update.
  porcelainStatus(): string
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: 'dirty-tree'; message: string }
  | { ok: false; reason: 'detached-head'; message: string }
  | { ok: false; reason: 'local-commits'; message: string; ahead: number }
  | { ok: false; reason: 'branch-not-on-origin'; message: string; branch: string }

// Concurrency gate: refuse a second /api/updates/apply while the first
// update.sh is still running. An in-memory timestamp would reset on the
// dashboard restart that happens mid-run, so the gate lives in a disk
// pidfile. The dashboard creates it atomically with O_EXCL before
// spawning; update.sh overwrites with its own PID early in its run and
// removes the file on EXIT via trap. Pidfile content: "<pid>\n<start-epoch-ms>\n".
export interface PidfileRunner {
  // The raw contents of store/update.pid, or null if the file does not
  // exist / cannot be read. Implementations must not throw.
  readPidfile(): string | null
  // True if a process with the given PID is alive. On Unix this is the
  // kill(pid, 0) probe: ESRCH means dead, EPERM means alive but owned
  // by a different uid, anything else treated as alive for safety.
  isProcessAlive(pid: number): boolean
  // Current wall-clock epoch in milliseconds. Injected for
  // deterministic age-comparison tests.
  now(): number
}

export type ConcurrencyResult =
  | { ok: true }
  | { ok: false; reason: 'already-running'; pid: number; message: string }

// Max age before a live-looking pidfile is treated as stale anyway.
// This guards against PID recycling after SIGKILL / power loss: if a
// pidfile survives a kernel kill and the OS later recycles its PID to
// an unrelated process, kill(pid, 0) would report "alive" forever. A
// typical update is well under five minutes; one hour is twelve times
// the upper end of the normal distribution and still short enough
// that an operator waiting on a genuinely runaway update will notice
// and intervene.
export const MAX_PIDFILE_AGE_MS = 60 * 60 * 1000

// Classify the errno from the retry writeFileSync that follows a
// stale-pidfile unlink. Only EEXIST means a parallel caller genuinely
// raced us to the lock; any other code is a real write failure
// (EACCES, EROFS, ENOSPC) and should surface as 500 instead of 409.
export type LockWriteErrorKind = 'race' | 'other'

export function classifyLockWriteError(code: string | undefined): LockWriteErrorKind {
  return code === 'EEXIST' ? 'race' : 'other'
}

export function checkNoConcurrentUpdate(pf: PidfileRunner): ConcurrencyResult {
  const raw = pf.readPidfile()
  if (raw === null) return { ok: true }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true }
  // Accept pidfile formats:
  //   "<pid>"                       (legacy, echo $$ only)
  //   "<pid>\n<start-epoch-ms>\n"   (dashboard-written, preferred)
  //   "<pid> garbage..."            (pid parsed from leading digits)
  const match = trimmed.match(/^(\d+)(?:[\s\r\n]+(\d+))?/)
  if (!match) return { ok: true }
  const pid = Number.parseInt(match[1], 10)
  // PID 0 and 1 are reserved / init; treating them as alive would
  // permanently lock the button if a stale pidfile ever contained one.
  if (!Number.isFinite(pid) || pid <= 1) return { ok: true }
  // If the optional second line is present and older than the max
  // age, treat as stale regardless of kill(pid, 0). Missing second
  // line means a legacy pidfile with no age info: fall through to
  // the alive probe alone.
  if (match[2]) {
    const startEpoch = Number.parseInt(match[2], 10)
    if (Number.isFinite(startEpoch) && startEpoch > 0) {
      const age = pf.now() - startEpoch
      if (age > MAX_PIDFILE_AGE_MS) return { ok: true }
    }
  }
  if (!pf.isProcessAlive(pid)) return { ok: true }
  return {
    ok: false,
    reason: 'already-running',
    pid,
    message: `Update already running (pid ${pid}). Wait for it to finish, then retry.`,
  }
}

export function checkUpdatePreflight(git: GitRunner): PreflightResult {
  const branch = git.currentBranch().trim()

  // `git rev-parse --abbrev-ref HEAD` prints "HEAD" on a detached
  // checkout. A detached HEAD has no branch to pull from, so it is the
  // one branch state the update cannot proceed from. Any named branch
  // is fine: update.sh pulls origin/<that-branch>.
  if (!branch || branch === 'HEAD') {
    return {
      ok: false,
      reason: 'detached-head',
      message:
        'Repository is in a detached-HEAD state. ' +
        'Check out a release branch before updating, e.g.: git checkout main',
    }
  }

  // update.sh guard 2: `git ls-remote --exit-code --heads origin <branch>`.
  // A branch that exists only locally has no ref to fast-forward to, so the
  // script exits 2 before doing anything. The dashboard spawns it detached
  // with its output going to a log nobody is watching, answers {ok:true},
  // and the UI shows "reloading in 30s" for a run that could never start --
  // exactly the lie this module exists to prevent. Measured 2026-09-05 on
  // this install: branch fix/email-gate-mcp-matcher, ls-remote exit 2,
  // preflight ok, update.sh exit 2.
  // Ordered to match update.sh: this check runs BEFORE the dirty-tree one
  // there, so the operator sees the same first reason from either entry
  // point instead of being sent to stash changes that would not have helped.
  if (git.originHasBranch(branch) === 'no') {
    return {
      ok: false,
      reason: 'branch-not-on-origin',
      branch,
      message:
        `Branch '${branch}' does not exist on origin, so there is nothing to ` +
        'pull. Updates can only run from a branch that origin also has, e.g.: ' +
        'git checkout main',
    }
  }

  // HEARTBEAT.md is self-modifying (rewritten by the agent every heartbeat).
  // Treating it as a blocker means the update button is almost always
  // refused in practice. Skip it from the dirty check; the file is
  // gitignore'd as "tracked-but-mutable" by convention. Any other dirty
  // file still blocks (see update.sh which stashes HEARTBEAT.md before
  // git pull and pops it after).
  const dirty = git.porcelainStatus()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/\sHEARTBEAT\.md$/.test(l))
  if (dirty.length > 0) {
    return {
      ok: false,
      reason: 'dirty-tree',
      message:
        'Working tree has uncommitted changes (staged or unstaged). ' +
        'Commit or stash them before updating: git stash',
    }
  }

  // A DIVERGED history -- ahead AND behind together -- is what `git pull
  // --ff-only` refuses, and because update.sh runs detached the abort is
  // invisible (the update looks "started" then reloads to the same commit
  // list). Catch it here with an actionable message instead of that silent
  // death. A running agent committing to its own tracked CLAUDE.md/SOUL.md/
  // task-config is the usual cause. The tree is clean (changes are
  // committed), so the dirty-tree stash cannot help; reconciliation is a
  // separate, explicit step.
  // Ahead ALONE is deliberately NOT blocked: update.sh stopped refusing on
  // it (the operator's checkout sat 53 ahead / 0 behind on 2026-08-30 and
  // was locked out of its own updater), but this copy of the rule was never
  // updated with it, so the button stayed refused where the script would
  // have run. Both sides now use the same condition.
  const ahead = git.aheadCount()
  const behind = git.behindCount()
  if (ahead > 0 && behind > 0) {
    return {
      ok: false,
      reason: 'local-commits',
      ahead,
      message:
        `The local checkout is ${ahead} commit(s) ahead and ${behind} behind the ` +
        'upstream (the histories have parted), so a fast-forward update is not ' +
        'possible. Reconcile them first. Review with: git log @{u}..HEAD',
    }
  }

  return { ok: true }
}
