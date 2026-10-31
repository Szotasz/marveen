// Shared marker list for the live-install gates (assert-not-live-install.ts, the
// per-worker setup file, and global-live-install-gate.ts, the vitest globalSetup).
//
// A live install is recognized by runtime artifacts only a running fleet produces;
// a fresh clone or worktree has none of them. Existence checks only -- the files
// hold secrets and a database, and this module must never read their contents.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const LIVE_MARKERS = [
  join('store', '.dashboard-token'),
  join('store', 'claudeclaw.db'),
  join('store', '.claude-oauth-token'),
]

/** The markers (relative paths) that exist under `root`; empty for a clean checkout. */
export function findLiveMarkers(root: string): string[] {
  return LIVE_MARKERS.filter((m) => existsSync(join(root, m)))
}
