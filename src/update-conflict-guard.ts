// UPDATECONFLICT1105: the dashboard side of scripts/update-conflict-guard.sh. The guard (run by start.sh) writes
// store/update-conflict-guard.json when an update left a conflicted tracked file; this reads it back, strictly, so the
// dashboard can say in one sentence what happened and where the backup is. Anything malformed reads as "no report".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONFLICT_GUARD_FILE = 'update-conflict-guard.json'

export type ConflictGuardState =
  | 'repaired' | 'refused_no_stash' | 'refused_in_progress' | 'backup_failed' | 'repair_failed' | 'markers_only'
const STATES: ReadonlySet<string> = new Set([
  'repaired', 'refused_no_stash', 'refused_in_progress', 'backup_failed', 'repair_failed', 'markers_only',
])

export interface ConflictGuardReport {
  state: ConflictGuardState
  /** epoch ms of the guard run; the banner's dismissal key */
  at: number
  /** the install-relative paths concerned (at most MAX_PATHS) */
  paths: string[]
  /** install-relative backup dir, e.g. store/update-conflict-backup-20261105-091500-a1B2c3 */
  backup?: string
  /** the `git stash list` line that holds the operator's copy */
  stash?: string
}

const MAX_PATHS = 20
const MAX_PATH_LEN = 300
const BACKUP_RE = /^store\/update-conflict-backup-\d{8}-\d{6}-[A-Za-z0-9]{6}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export function parseConflictGuard(raw: unknown): ConflictGuardReport | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.state !== 'string' || !STATES.has(r.state)) return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at <= 0) return null
  if (!Array.isArray(r.paths)) return null
  const paths = r.paths
    .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LEN && !CONTROL_RE.test(p))
    .slice(0, MAX_PATHS)
  const out: ConflictGuardReport = { state: r.state as ConflictGuardState, at: r.at, paths }
  if (typeof r.backup === 'string' && BACKUP_RE.test(r.backup)) out.backup = r.backup
  if (typeof r.stash === 'string' && r.stash.length <= 200 && !CONTROL_RE.test(r.stash)) out.stash = r.stash
  return out
}

export function readConflictGuard(storeDir: string): ConflictGuardReport | null {
  try {
    return parseConflictGuard(JSON.parse(readFileSync(join(storeDir, CONFLICT_GUARD_FILE), 'utf-8')))
  } catch {
    return null
  }
}
