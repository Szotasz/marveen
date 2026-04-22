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
// pidfile that update.sh owns for its lifetime (trap EXIT removes it).
export interface PidfileRunner {
  // The raw contents of store/update.pid, or null if the file does not
  // exist / cannot be read. Implementations must not throw.
  readPidfile(): string | null
  // True if a process with the given PID is alive. On Unix this is the
  // kill(pid, 0) probe: ESRCH means dead, EPERM means alive but owned
  // by a different uid, anything else treated as alive for safety.
  isProcessAlive(pid: number): boolean
}

export type ConcurrencyResult =
  | { ok: true }
  | { ok: false; reason: 'already-running'; pid: number; message: string }

export function checkNoConcurrentUpdate(pf: PidfileRunner): ConcurrencyResult {
  const raw = pf.readPidfile()
  if (raw === null) return { ok: true }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true }
  // Parse only a leading integer. A pidfile with trailing junk (a stray
  // newline, a commented-out note) still yields a clean pid; garbage
  // with no digits yields NaN and is treated as stale.
  const match = trimmed.match(/^(\d+)/)
  if (!match) return { ok: true }
  const pid = Number.parseInt(match[1], 10)
  // PID 0 and 1 are reserved / init; treating them as "alive" would
  // permanently lock the button if a stale pidfile ever contained one.
  if (!Number.isFinite(pid) || pid <= 1) return { ok: true }
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
