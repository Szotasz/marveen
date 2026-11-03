// INSTALLDIRTYTREE1103: run scripts/install-drift-repair.py before the update
// preflight. Up to v1.46.0 a fresh install dirtied three tracked files itself
// (the reformatted .claude/settings.json, the Bridge's headless installer, the
// npm lock line), so the "update now" button always met a dirty tree and the
// update went down the stash path (marveen2, 11-03: the stash pop conflicted
// inside settings.json). The script restores ONLY provably install-generated
// changes; anything else stays and the preflight reports it as before.
//
// Best effort by design: a missing python3, a timeout or a crash is logged and
// the update flow continues exactly as it would have without this step.
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

type ExecFn = (file: string, args: string[], opts: { cwd: string; timeout: number }) =>
  Promise<{ code: number; stdout: string }>

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, encoding: 'utf-8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

export async function runInstallDriftRepair(projectRoot: string, exec: ExecFn = defaultExec): Promise<DriftRepairOutcome> {
  const script = join(projectRoot, 'scripts', 'install-drift-repair.py')
  try {
    const { code, stdout } = await exec('python3', [script, '--install-dir', projectRoot, '--json'], { cwd: projectRoot, timeout: 30_000 })
    const line = stdout.trim().split('\n').pop() ?? ''
    const parsed = JSON.parse(line) as { results?: DriftRepairResult[]; error?: string }
    return { ran: true, exitCode: code, results: parsed.results ?? [], ...(parsed.error ? { error: parsed.error } : {}) }
  } catch (err) {
    return { ran: false, exitCode: null, results: [], error: err instanceof Error ? err.message : String(err) }
  }
}
