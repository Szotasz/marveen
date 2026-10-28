// Source-side guard for the scheduled-task store.
//
// Scheduled tasks live as files in ~/.claude/scheduled-tasks/<name>/ and the
// runner injects their prompt into an agent's tmux session every tick. Any
// process that can write the directory directly (an agent's Write/Edit tool, a
// cp, a tampered seed) could plant or alter a task, and the runner would fire
// it with no API call at all. This module closes that path:
//
//   * every server-side write (POST/PUT/toggle route, the repo-default seeder,
//     the fleet import, the explicit operator CLI, and the server's own rewrites
//     in schedule-registry-rewrite.ts: once-disable, rotation heartbeat) records
//     name -> sha256(task files: SKILL.md, task-config.json, the preCheck
//     script, and every other file under the task's own dir) in the
//     server-owned SQLite DB (scheduled_task_registry), never in the tasks dir;
//   * the runner fires a task only if the hash of the bytes it just parsed
//     (ScheduledTask.contentHash) equals the registered hash; otherwise the task
//     is skipped with a warning and nothing else changes (no crash, no delete);
//   * DELETE removes the registry entry.
//
// Upgrade path: the FIRST start of a build that contains this guard registers
// every task present on disk at that moment (one-time, marker-guarded, logged
// with the task names) -- the same trust the runner extended to those files
// before the upgrade. After that, only the paths above can register. Tasks the
// shell seeders (update.sh / installers) write are registered through the CLI
// (src/web/schedule-registry-cli.ts); see docs/scheduled-tasks.md
// ("Forrás-oldali védelem").
//
// Scope, stated honestly: the registry lives in store/claudeclaw.db, which a
// same-user process could also write. The guard stops FILE-ONLY plants (a
// Write/Edit/cp into the tasks dir, a symlinked config path, a tampered seed);
// planting a task now also takes a deliberate DB write or CLI call. The hash
// covers the task's OWN directory (and a preCheck script wherever it points,
// except repo-shipped scripts/). A `command` or a prompt that points into
// ANOTHER task's dir, or anywhere else outside the repo's scripts/, runs or
// reads content the registry never saw; that is not covered.

import { logger } from '../logger.js'
import {
  upsertScheduledTaskRegistry,
  getScheduledTaskRegistryEntry,
  deleteScheduledTaskRegistryEntry,
  getScheduledTaskRegistryState,
  setScheduledTaskRegistryState,
} from '../db.js'
import { join } from 'node:path'
import {
  SCHEDULED_TASKS_DIR, PRECHECK_ABSENT, listScheduledTasks, readScheduledTask, scheduledTaskHashFromFiles,
  type ScheduledTask, type ScheduledTaskWritten,
} from './scheduled-tasks-io.js'

export const REGISTRY_BACKFILL_MARKER = 'upgrade-backfill-v1'

export type RegistryVerdict =
  | { ok: true }
  | { ok: false; reason: 'unregistered' | 'hash-mismatch' | 'no-hash' | 'registry-error'; detail?: string }

function keyOf(task: Pick<ScheduledTask, 'name' | 'dirName'>): string {
  return task.dirName ?? task.name
}

// Record a task as trusted. Returns the hash, or null when nothing was
// registered.
//
// Without `written`: the CURRENT on-disk content (operator CLI, backfill,
// seeders, server rewrites after a trust check).
// With `written` (the bytes the caller itself just wrote): the files on disk
// must still be exactly those bytes, else nothing is registered and null comes
// back -- a concurrent writer between the write and this call, or a leftover
// file the writer did not write (an import into an existing dir), never gets
// trusted along with it. `noUnwrittenPreCheck`: also refuse when the task's
// hashed preCheck script exists on disk, i.e. a script the writer did not
// write (the fleet import ships no scripts). `noUnwrittenDirFiles`: also
// refuse when the task dir holds any file besides SKILL.md and
// task-config.json (a writer that wrote only those two: create, import), so a
// file dropped into a fresh dir between the write and this call is not
// trusted with it.
export function registerScheduledTask(
  dirName: string,
  source: string,
  written?: ScheduledTaskWritten,
  opts: { noUnwrittenPreCheck?: boolean; noUnwrittenDirFiles?: boolean } = {},
): string | null {
  const task = readScheduledTask(dirName)
  if (!task?.contentHash) return null
  if (written) {
    const toBuf = (v: string | Buffer | null) => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf-8'))
    const expected = scheduledTaskHashFromFiles(join(SCHEDULED_TASKS_DIR, dirName), toBuf(written.skill), toBuf(written.config))
    if (expected.contentHash !== task.contentHash) {
      logger.warn({ task: dirName, source }, 'schedule-registry: task files on disk differ from what was just written; NOT registered')
      return null
    }
    if (opts.noUnwrittenPreCheck && task.preCheckSha256 !== undefined && task.preCheckSha256 !== PRECHECK_ABSENT) {
      logger.warn({ task: dirName, source }, 'schedule-registry: task references a preCheck script that was not part of this write; NOT registered')
      return null
    }
    if (opts.noUnwrittenDirFiles && task.dirFiles !== 0) {
      logger.warn({ task: dirName, source, dirFiles: task.dirFiles }, 'schedule-registry: task dir holds files that were not part of this write; NOT registered')
      return null
    }
  }
  upsertScheduledTaskRegistry(dirName, task.contentHash, source)
  return task.contentHash
}

export function unregisterScheduledTask(dirName: string): boolean {
  return deleteScheduledTaskRegistryEntry(dirName)
}

// Pure decision over one task. Fail-closed: a registry read error is a skip,
// never a fire -- this is a security gate, and a broken DB is loud elsewhere.
export function verifyScheduledTask(task: Pick<ScheduledTask, 'name' | 'dirName' | 'contentHash'>): RegistryVerdict {
  if (!task.contentHash) return { ok: false, reason: 'no-hash' }
  let entry: ReturnType<typeof getScheduledTaskRegistryEntry>
  try {
    entry = getScheduledTaskRegistryEntry(keyOf(task))
  } catch (err) {
    return { ok: false, reason: 'registry-error', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!entry) return { ok: false, reason: 'unregistered' }
  if (entry.sha256 !== task.contentHash) return { ok: false, reason: 'hash-mismatch' }
  return { ok: true }
}

// One warning per distinct (task, reason, current hash) per process: the runner
// ticks every 60 s, and a repeated identical line every minute is the kind of
// signal that stops being read. A further edit (new hash) warns again.
const warned = new Set<string>()
// Skip keys seen on the PREVIOUS call but not yet confirmed (see
// filterRegisteredTasks): a mismatch that is gone by the next tick never
// reaches the log or the main agent.
let suspects = new Set<string>()

export function _resetRegistryWarningsForTest(): void {
  warned.clear()
  suspects = new Set<string>()
}

export function describeVerdict(v: Exclude<RegistryVerdict, { ok: true }>): string {
  switch (v.reason) {
    case 'unregistered':
      return 'task files were not written by the dashboard API (no registry entry)'
    case 'hash-mismatch':
      return 'task files changed on disk after the dashboard API last wrote them (hash mismatch)'
    case 'no-hash':
      return 'task content hash could not be computed'
    case 'registry-error':
      return `registry unreadable (${v.detail ?? 'unknown error'})`
  }
}

// Directory names come from readdirSync, so a planted dir can be named with any
// text at all. Anything that leaves this module toward an agent (the main-agent
// notice) carries only this reduced form, never the raw name or the task body.
export function safeTaskLabel(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)
  return s || '(unnamed)'
}

// The runner's gate: keep only tasks whose files match the registry. Skipped
// tasks are logged (deduped) and otherwise left alone -- not deleted, not
// disabled -- so the operator can inspect and re-register them. A DISABLED task
// that fails the check is dropped silently: it would not fire anyway, and an
// imported/paused task must not raise an alarm every restart. `onFirstSkip`
// runs once per dedupe key (the runner uses it for a main-agent notice).
//
// The warning and the notice go out only when the SAME skip (task, reason,
// hash) is seen on two consecutive calls, i.e. two runner ticks. A transient
// state -- an updater rewriting a task's files a moment before it re-registers
// them, a one-off registry-error -- is over by the next tick, and a "NOT
// firing" notice for it is a false alarm. The task is still skipped on the
// first call (the gate itself is unchanged); only the reporting waits. The
// runner is the only caller, once per tick: a second caller would make
// "consecutive calls" mean something else.
export function filterRegisteredTasks<T extends Pick<ScheduledTask, 'name' | 'dirName' | 'contentHash' | 'enabled'>>(
  tasks: T[],
  onFirstSkip?: (label: string, verdict: Exclude<RegistryVerdict, { ok: true }>) => void,
): T[] {
  const out: T[] = []
  const prevSuspects = suspects
  suspects = new Set<string>()
  for (const t of tasks) {
    const v = verifyScheduledTask(t)
    if (v.ok) { out.push(t); continue }
    if (t.enabled === false) continue
    const key = `${keyOf(t)}|${v.reason}|${t.contentHash ?? ''}`
    if (warned.has(key)) continue
    if (!prevSuspects.has(key)) { suspects.add(key); continue }
    warned.add(key)
    const label = safeTaskLabel(keyOf(t))
    logger.warn(
      { task: keyOf(t), reason: v.reason, contentHash: t.contentHash },
      `schedule-runner: NOT firing scheduled task "${label}": ${describeVerdict(v)}. ` +
        'If this change is legitimate, save the task through the dashboard/API, or review the files and re-register: ' +
        `node dist/web/schedule-registry-cli.js register ${label}`,
    )
    try { onFirstSkip?.(label, v) } catch (err) {
      logger.warn({ err, task: label }, 'schedule-registry: skip notice failed (non-fatal)')
    }
  }
  return out
}

// Register every task currently on disk. Used by the one-time upgrade backfill
// and by the explicit `register --all` CLI command.
export function registerAllScheduledTasks(source: string): string[] {
  const names: string[] = []
  for (const t of listScheduledTasks()) {
    if (!t.contentHash) continue
    const dirName = keyOf(t)
    upsertScheduledTaskRegistry(dirName, t.contentHash, source)
    names.push(dirName)
  }
  return names.sort()
}

// One-time upgrade migration, run at runner start. Registers the tasks present
// at upgrade time, then sets a marker so it NEVER runs again -- after that a
// plant can only become firable through a server write or the explicit CLI.
export function backfillScheduledTaskRegistryOnce(): { ran: boolean; registered: string[] } {
  if (getScheduledTaskRegistryState(REGISTRY_BACKFILL_MARKER)) return { ran: false, registered: [] }
  const registered = registerAllScheduledTasks('upgrade-backfill')
  setScheduledTaskRegistryState(REGISTRY_BACKFILL_MARKER, JSON.stringify({ at: Date.now(), count: registered.length }))
  logger.warn(
    { count: registered.length, tasks: registered },
    'schedule-registry: one-time upgrade backfill registered every scheduled task present on disk; ' +
      'from now on only tasks written through the dashboard API (or re-registered via the CLI) will fire',
  )
  return { ran: true, registered }
}
