// Preflight check for the in-dashboard "Update now" button.
//
// The previous flow was:
//   1. user clicks "Frissítés most"
//   2. backend spawns update.sh (detached, stdio ignored)
//   3. frontend receives { ok: true }, shows "Frissítés elindult..."
//   4. after 30s the page reloads and shows the same pending commits
//
// The silent failure mode is update.sh hitting `git pull --ff-only origin
// main` while the local checkout is on a feature branch (or has local
// modifications that would make a fast-forward impossible). set -e in
// update.sh makes it exit before the stop.sh / start.sh step, but the
// frontend has no way to know because it only watched spawn() success.
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
  // Porcelain status excluding untracked files. Non-empty = dirty tree.
  // Untracked files are excluded because the repo legitimately carries
  // ad-hoc backup files (CLAUDE.md.backup-*, SOUL.md mid-edit, etc.)
  // that should not block an update.
  porcelainStatus(): string
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: 'not-on-main'; branch: string; message: string }
  | { ok: false; reason: 'dirty-tree'; message: string }
  | { ok: false; reason: 'detached-head'; message: string }

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

const EXPECTED_BRANCH = 'main'

export function checkUpdatePreflight(git: GitRunner): PreflightResult {
  const branch = git.currentBranch().trim()

  // `git rev-parse --abbrev-ref HEAD` prints "HEAD" on a detached
  // checkout. Treat that separately so the error message can explain
  // it instead of claiming the branch is called "HEAD".
  if (!branch || branch === 'HEAD') {
    return {
      ok: false,
      reason: 'detached-head',
      message:
        'Repository is in a detached-HEAD state. Check out main before updating: git checkout main',
    }
  }

  if (branch !== EXPECTED_BRANCH) {
    return {
      ok: false,
      reason: 'not-on-main',
      branch,
      message:
        `Cannot update from branch '${branch}'. ` +
        `'git pull --ff-only origin main' cannot fast-forward a feature branch. ` +
        `Switch to main first: git checkout main`,
    }
  }

  const dirty = git.porcelainStatus().trim()
  if (dirty.length > 0) {
    return {
      ok: false,
      reason: 'dirty-tree',
      message:
        'Working tree has uncommitted changes (staged or unstaged). ' +
        'Commit or stash them before updating: git stash',
    }
  }

  return { ok: true }
}
