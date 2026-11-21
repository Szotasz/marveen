// NUDGESHORT1031: every LOCAL scheduled fire now writes a snapshot and types a
// short pointer to it. Tests that drive the real tick would therefore write
// into the checkout's store/scheduled-runs/ on every run, and an assertion on
// the typed prompt would only see the pointer -- a `not.toContain` on it passes
// whatever the task text is.
//
// redirectScheduledRuns: the vi.mock factory body for the snapshot module,
// used by setup/scheduled-runs-tmp-seam.ts for the whole suite. Snapshots go to
// a bounded per-worker tmp dir (cleared on entry, the pattern of
// setup/default-ssh-dir-seam.ts), and the reference check accepts that dir.
//
// deliveredTaskText: what the agent ends up reading for a typed prompt -- the
// body-file's text for a pointer, the prompt itself for an inline delivery.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Snapshot from '../../web/scheduled-run-snapshot.js'

export function redirectScheduledRuns(real: typeof Snapshot): typeof Snapshot {
  const slot = (process.env.VITEST_POOL_ID || String(process.pid)).replace(/[^A-Za-z0-9_-]/g, '_')
  const dir = join(tmpdir(), 'marveen-scheduled-runs-test', `w${slot}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return {
    ...real,
    SCHEDULED_RUNS_DIR: dir,
    writeScheduledRunSnapshot: (taskName, body, opts = {}) => real.writeScheduledRunSnapshot(taskName, body, { ...opts, dir: opts.dir ?? dir }),
    isScheduledRunReference: (filePath, d = dir) => real.isScheduledRunReference(filePath, d),
  }
}

export function deliveredTaskText(prompt: string): string {
  const m = prompt.match(/^body-file="([^"]+)"/m)
  return m ? readFileSync(m[1], 'utf-8') : prompt
}
