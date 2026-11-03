// INSTALLDIRTYTREE1103: ask scripts/install-drift-repair.py (DRY RUN) before the
// update preflight. Up to v1.46.0 a fresh install dirtied three tracked files itself
// (the reformatted .claude/settings.json, the Bridge's headless installer, the
// npm lock line), so the "update now" button always met a dirty tree and the
// update went down the stash path (marveen2, 11-03: the stash pop conflicted
// inside settings.json). The script restores ONLY provably install-generated
// changes; anything else stays and the preflight reports it as before.
//
// The dashboard only ASKS (--dry-run) and writes nothing (Samu 67345 (A)): a
// restore here, with the services still running, could flip a live Slack
// primary's enabledPlugins and, if the preflight then stopped for any other
// reason, leave the restored file without the restart that makes it consistent.
// The preflight ignores exactly the paths the dry run classifies as "restore";
// the actual restore is done by update.sh, before its own dirty guard, in the
// run that ends with a restart.
//
// Best effort by design: a missing python3, a timeout or a crash is logged and
// the update flow continues exactly as it would have without this step (no path
// is ignored then, so the preflight is as strict as before).
import { execFile } from 'node:child_process'
import { join } from 'node:path'

export interface DriftRepairResult {
  path: string
  status: string
  action: 'restore' | 'restored' | 'restore-failed' | 'leave'
  reason: string
}

export interface DriftRepairOutcome {
  ran: boolean
  exitCode: number | null
  results: DriftRepairResult[]
  error?: string
}

export interface DriftRepairOptions {
  /** Decide and report only; the script writes nothing. */
  dryRun?: boolean
  /** Where overwritten files are copied first; default ~/.marveen-repair/backup-<UTC ts>. */
  backupDir?: string
}

type ExecFn = (file: string, args: string[], opts: { cwd: string; timeout: number }) =>
  Promise<{ code: number; stdout: string }>

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, encoding: 'utf-8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

export async function runInstallDriftRepair(projectRoot: string, exec: ExecFn = defaultExec, opts: DriftRepairOptions = {}): Promise<DriftRepairOutcome> {
  const script = join(projectRoot, 'scripts', 'install-drift-repair.py')
  const args = [script, '--install-dir', projectRoot, '--json',
    ...(opts.dryRun ? ['--dry-run'] : []), ...(opts.backupDir ? ['--backup-dir', opts.backupDir] : [])]
  try {
    const { code, stdout } = await exec('python3', args, { cwd: projectRoot, timeout: 30_000 })
    const line = stdout.trim().split('\n').pop() ?? ''
    const parsed = JSON.parse(line) as { results?: DriftRepairResult[]; error?: string }
    return { ran: true, exitCode: code, results: parsed.results ?? [], ...(parsed.error ? { error: parsed.error } : {}) }
  } catch (err) {
    return { ran: false, exitCode: null, results: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** The paths a DRY RUN would restore: provably install-generated, restored by update.sh. */
export function generatedDriftPaths(outcome: DriftRepairOutcome): Set<string> {
  if (!outcome.ran) return new Set()
  return new Set(outcome.results.filter((r) => r.action === 'restore').map((r) => r.path))
}

/**
 * `git status --porcelain --untracked-files=no` without the lines for `paths`.
 * Only the exact path matches; a quoted or renamed entry ("a -> b") never does,
 * so anything unusual stays in and keeps blocking, as before.
 */
export function withoutGeneratedDrift(porcelain: string, paths: ReadonlySet<string>): string {
  if (paths.size === 0) return porcelain
  return porcelain
    .split('\n')
    .filter((line) => !(line.length > 3 && paths.has(line.slice(3))))
    .join('\n')
}
