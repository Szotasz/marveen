// SCHEDPROMPTREF917: reference-based scheduled-task delivery.
//
// The runner used to tmux-paste the ENTIRE task body (SKILL.md + pre-check +
// metrics) into the agent's session on every fire. Eight measured
// corruptions since 2026-09-11 (scrambled sentences, truncated headers, one
// task's SKILL.md paragraph bleeding into another's) all shared one trait:
// size. The "close-timing" theory (two tasks firing within seconds) was
// disproved by measurement -- the closest pair (21s apart) was intact, and
// 1630 sub-90s pairs fired clean historically. See spec 1.1.
//
// Fix: fire-time snapshot the full, final body to an immutable file and send
// only a short reference through tmux. The agent Reads the file instead of
// receiving it via send-keys. The prompt length going through tmux stops
// depending on task size entirely -- the corruption PATH is closed, not just
// made rarer.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, isAbsolute, relative, resolve, sep } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { scrubSecurityTags } from '../prompt-safety.js'

export const SCHEDULED_RUNS_DIR = join(STORE_DIR, 'scheduled-runs')

// Retention (spec 3.4): delete anything older than 7 days, but always keep
// each task's most recent 20 snapshots regardless of age -- a quiet task
// (e.g. a weekly report) must not lose its only recent evidence to a blanket
// age sweep.
export const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const SNAPSHOT_RETENTION_KEEP_PER_TASK = 20

// A run-away task name should never widen the on-disk glob beyond what the
// filename parser expects back; the runner's own task names are already
// directory-safe (they come from SCHEDULED_TASKS_DIR entries), this is a
// second, cheap belt for the file this function writes.
function sanitizeTaskNameForFilename(taskName: string): string {
  const cleaned = taskName.replace(/[^a-zA-Z0-9_-]/g, '-')
  return cleaned.length > 0 ? cleaned : 'task'
}

function timestampSegment(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function buildSnapshotFilename(taskName: string, firedAt: Date, rand4: string): string {
  return `${timestampSegment(firedAt)}-${sanitizeTaskNameForFilename(taskName)}-${rand4}.md`
}

// Inverse of buildSnapshotFilename, used by the retention sweep to group
// files by task without trusting anything other than the shape it itself
// produced. Non-matching files (foreign to this dir) are left alone.
const SNAPSHOT_FILENAME_RX = /^(\d{8}-\d{6})-(.+)-([0-9a-f]{4})\.md$/

export function parseSnapshotFilename(filename: string): { timestampSegment: string; taskName: string } | null {
  const m = SNAPSHOT_FILENAME_RX.exec(filename)
  if (!m) return null
  return { timestampSegment: m[1], taskName: m[2] }
}

// A body-file reference is granted inline-level trust (SCHEDULED_TASK_PREAMBLE),
// so the runner only ever sends one that points at a snapshot it could have
// written itself: an absolute path, no `..` segment, a direct child of
// SCHEDULED_RUNS_DIR, in the filename shape buildSnapshotFilename produces.
// Anything else is REJECTED and logged with the offending path -- never
// silently skipped -- and the caller delivers the task inline instead.
export function isScheduledRunReference(filePath: string, dir: string = SCHEDULED_RUNS_DIR): boolean {
  const reject = (reason: string): boolean => {
    logger.warn({ filePath, dir, reason }, 'scheduled-run reference rejected: body-file must be a snapshot under store/scheduled-runs/')
    return false
  }
  if (!isAbsolute(filePath)) return reject('not an absolute path')
  if (filePath.split(/[\\/]/).includes('..')) return reject('contains a .. segment')
  const rel = relative(resolve(dir), resolve(filePath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return reject('outside the scheduled-runs directory')
  if (rel.includes(sep) || rel.includes('/')) return reject('not a direct child of the scheduled-runs directory')
  if (!parseSnapshotFilename(rel)) return reject('not a snapshot filename')
  return true
}

export interface ScheduledRunSnapshot {
  filePath: string
  sha256: string
  chars: number
}

export interface SkillSourceInfo {
  sha256: string
  mtime: string
}

// Best-effort provenance for the snapshot header: which on-disk SKILL.md
// version fired. Never throws -- a missing/unreadable source (command-type
// tasks have none) just means the header says "unknown".
export function readSkillSourceInfo(skillPath: string): SkillSourceInfo | null {
  try {
    const raw = readFileSync(skillPath)
    const sha256 = createHash('sha256').update(raw).digest('hex')
    const mtime = statSync(skillPath).mtime.toISOString()
    return { sha256, mtime }
  } catch {
    return null
  }
}

function buildSnapshotHeader(taskName: string, firedAt: Date, skillSource: SkillSourceInfo | null): string {
  const skillSha256 = skillSource?.sha256 ?? 'unknown'
  const skillMtime = skillSource?.mtime ?? 'unknown'
  return `<!-- scheduled-run task=${taskName} fired_at=${firedAt.toISOString()} skill_sha256=${skillSha256} skill_mtime=${skillMtime} -->\n`
}

const SNAPSHOT_WRITE_MAX_ATTEMPTS = 5

// Write the fire-time snapshot: header + the same scrubbed body that would
// otherwise have gone inline through tmux. Immutable, atomic (tmp + rename),
// 0600. Returns null (and logs) on any failure -- the caller's job is to fall
// back to the inline path, never to drop the task (test 11).
export function writeScheduledRunSnapshot(
  taskName: string,
  body: string,
  opts: { firedAt?: Date; skillPath?: string; dir?: string } = {},
): ScheduledRunSnapshot | null {
  const dir = opts.dir ?? SCHEDULED_RUNS_DIR
  const firedAt = opts.firedAt ?? new Date()
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (err) {
    logger.error({ err, taskName }, 'scheduled-run-snapshot: mkdir failed, falling back to inline delivery')
    return null
  }
  const skillSource = opts.skillPath ? readSkillSourceInfo(opts.skillPath) : null
  const scrubbedBody = scrubSecurityTags(body)
  const content = buildSnapshotHeader(taskName, firedAt, skillSource) + scrubbedBody
  const sha256 = createHash('sha256').update(scrubbedBody).digest('hex')

  for (let attempt = 0; attempt < SNAPSHOT_WRITE_MAX_ATTEMPTS; attempt++) {
    const rand4 = randomBytes(2).toString('hex')
    const filename = buildSnapshotFilename(taskName, firedAt, rand4)
    const target = join(dir, filename)
    if (existsSync(target)) continue // same-second rand4 collision -- retry with a new one
    const tmp = `${target}.${process.pid}.${rand4}.tmp`
    try {
      writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' })
      chmodSync(tmp, 0o600)
      if (existsSync(target)) {
        // Lost the race between the existsSync check and the write; drop our
        // tmp and retry under a fresh rand4 rather than overwrite (test 6).
        try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
        continue
      }
      renameSync(tmp, target)
      // Code points, not UTF-16 units: the agent checks with Python len(), and
      // a JS .length counts an emoji twice (measured live: a "7 character"
      // mismatch on an emoji-bearing task).
      return { filePath: target, sha256, chars: [...scrubbedBody].length }
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      logger.warn({ err, taskName, attempt }, 'scheduled-run-snapshot: write attempt failed')
    }
  }
  logger.error({ taskName }, 'scheduled-run-snapshot: all write attempts failed, falling back to inline delivery')
  return null
}

interface SnapshotEntry {
  filePath: string
  taskName: string
  mtimeMs: number
}

// Pure retention decision, split out from the fs side so the "8-day-old
// files, latest 20 survive" rule (test 9) is directly testable without
// touching disk.
export function selectSnapshotsToDelete(
  entries: SnapshotEntry[],
  nowMs: number,
  opts: { retentionMs?: number; keepPerTask?: number } = {},
): string[] {
  const retentionMs = opts.retentionMs ?? SNAPSHOT_RETENTION_MS
  const keepPerTask = opts.keepPerTask ?? SNAPSHOT_RETENTION_KEEP_PER_TASK
  const byTask = new Map<string, SnapshotEntry[]>()
  for (const e of entries) {
    const list = byTask.get(e.taskName) ?? []
    list.push(e)
    byTask.set(e.taskName, list)
  }
  const toDelete: string[] = []
  for (const list of byTask.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (let i = keepPerTask; i < list.length; i++) {
      const e = list[i]
      if (nowMs - e.mtimeMs > retentionMs) toDelete.push(e.filePath)
    }
  }
  return toDelete
}

// Run one retention sweep over the on-disk snapshot dir. Never throws --
// mirrors runLogRotationSweep's per-file try/catch so a single bad stat/unlink
// never takes the whole sweep (or its hourly interval) down.
export function sweepScheduledRunSnapshots(
  dir: string = SCHEDULED_RUNS_DIR,
  nowMs: number = Date.now(),
): string[] {
  if (!existsSync(dir)) return []
  let filenames: string[] = []
  try {
    filenames = readdirSync(dir)
  } catch (err) {
    logger.error({ err, dir }, 'scheduled-run-snapshot: sweep readdir failed')
    return []
  }
  const entries: SnapshotEntry[] = []
  for (const filename of filenames) {
    const parsed = parseSnapshotFilename(filename)
    if (!parsed) continue
    const filePath = join(dir, filename)
    try {
      entries.push({ filePath, taskName: parsed.taskName, mtimeMs: statSync(filePath).mtimeMs })
    } catch { /* raced with another deletion -- skip */ }
  }
  const toDelete = selectSnapshotsToDelete(entries, nowMs)
  const deleted: string[] = []
  for (const filePath of toDelete) {
    try {
      unlinkSync(filePath)
      deleted.push(filePath)
    } catch (err) {
      logger.warn({ err, filePath }, 'scheduled-run-snapshot: sweep delete failed')
    }
  }
  if (deleted.length > 0) logger.info({ count: deleted.length }, 'scheduled-run-snapshot: retention sweep deleted old snapshots')
  return deleted
}
