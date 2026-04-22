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
